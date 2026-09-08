// @effect-diagnostics globalFetch:off -- Exercise the real HTTP proxy with an independent client.
// @effect-diagnostics nodeBuiltinImport:off -- This adapter preserves raw HTTP streams and WebSocket upgrades.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NodeWS } from "@effect/platform-node/NodeSocket";

import { createPortForwardProxy } from "./PortForwardProxy.ts";
import { forwardingLocation } from "./forwardingHeaders.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups.length = 0;
});

async function listen(server: NodeHttp.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return new URL(`http://127.0.0.1:${address.port}`);
}

async function fixture(handler: NodeHttp.RequestListener) {
  const upstream = NodeHttp.createServer(handler);
  const upstreamOrigin = await listen(upstream);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.close(() => resolve());
        upstream.closeAllConnections();
      }),
  );
  let publicOrigin = new URL("http://localhost");
  const proxy = createPortForwardProxy({
    upstream: upstreamOrigin,
    publicOrigin: () => publicOrigin,
    cookieName: "preview_session",
    authorize: (request) => request.headers.cookie?.includes("preview_session=valid") ?? false,
    handleGatewayRequest: () => false,
  });
  publicOrigin = await listen(proxy.server);
  cleanups.push(proxy.close);
  return { ...proxy, upstream, upstreamOrigin, publicOrigin };
}

const auth = { cookie: "preview_session=valid; app_session=app" };

describe("port forwarding proxy", () => {
  it("rewrites loopback redirect aliases without changing the preview authority", () => {
    const upstream = new URL("http://localhost:5173");
    const preview = new URL("http://preview.localhost:9000");
    expect(forwardingLocation("http://127.0.0.1:5173/login", upstream, preview)).toBe(
      "http://preview.localhost:9000/login",
    );
    expect(forwardingLocation("http://localhost:5173//nested?x=1", upstream, preview)).toBe(
      "http://preview.localhost:9000//nested?x=1",
    );
    expect(forwardingLocation("https://example.com/login", upstream, preview)).toBe(
      "https://example.com/login",
    );
  });

  it("delivers streaming responses before the upstream finishes", async () => {
    const upstreamReady = Promise.withResolvers<NodeHttp.ServerResponse>();
    const { publicOrigin } = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      upstreamReady.resolve(response);
    });
    const response = await fetch(publicOrigin, { headers: auth });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    const upstream = await upstreamReady.promise;
    expect(upstream.writableEnded).toBe(false);
    upstream.end("data: last\n\n");
    const last = await reader.read();
    expect(new TextDecoder().decode(last.value)).toBe("data: last\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("requires authentication before sending a request to the service", async () => {
    let requests = 0;
    const { publicOrigin } = await fixture((_request, response) => {
      requests++;
      response.end("private");
    });
    const response = await fetch(publicOrigin);
    expect(response.status).toBe(401);
    expect(requests).toBe(0);
  });

  it("streams request bodies and preserves paths, query strings, and application cookies", async () => {
    const { publicOrigin, upstreamOrigin } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () =>
        response.end(
          JSON.stringify({
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        ),
      );
    });
    const response = await fetch(new URL("/api/save?n=2", publicOrigin), {
      method: "POST",
      headers: {
        ...auth,
        authorization: "Bearer app-secret",
        dpop: "t3-proof",
        "x-forwarded-host": "attacker",
      },
      body: "document content",
    });
    const result = await response.json();
    expect(result).toMatchObject({
      url: "/api/save?n=2",
      method: "POST",
      body: "document content",
    });
    expect(result).toMatchObject({
      headers: {
        cookie: "app_session=app",
        host: upstreamOrigin.host,
        "x-forwarded-host": publicOrigin.host,
      },
    });
    expect(result).toHaveProperty("headers.authorization", "Bearer app-secret");
    expect(result).not.toHaveProperty("headers.dpop");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps redirects on the forwarded origin and prevents replacement of its credential", async () => {
    const { publicOrigin, upstreamOrigin } = await fixture((_request, response) => {
      response.writeHead(302, {
        location: `${upstreamOrigin.origin}/sign-in?next=%2F`,
        "set-cookie": [
          "preview_session=evil; Path=/",
          "app=ok; Domain=localhost; Path=/; HttpOnly",
        ],
      });
      response.end();
    });
    const response = await fetch(publicOrigin, { headers: auth, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${publicOrigin.origin}/sign-in?next=%2F`);
    expect(response.headers.getSetCookie()).toEqual(["app=ok; Path=/; HttpOnly"]);
  });

  it("returns a useful 502 when the service stops", async () => {
    const { publicOrigin, upstream } = await fixture((_request, response) => response.end());
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const response = await fetch(publicOrigin, { headers: auth });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("dev server is running");
  });

  it("rejects unauthenticated WebSocket upgrades", async () => {
    const { publicOrigin } = await fixture((_request, response) => response.end());
    const socket = NodeNet.connect(Number(publicOrigin.port), "127.0.0.1");
    cleanups.push(async () => {
      socket.destroy();
    });
    socket.write(
      "GET /hmr HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    const [data] = await NodeEvents.EventEmitter.once(socket, "data");
    expect(data.toString()).toContain("401 Unauthorized");
  });

  it("proxies WebSocket subprotocols, text and binary frames, and closes them on stop", async () => {
    const { publicOrigin, upstream, close } = await fixture((_request, response) => response.end());
    const wsServer = new NodeWS.WebSocketServer({ server: upstream });
    wsServer.on("connection", (socket) => {
      socket.on("message", (message, binary) => socket.send(message, { binary }));
    });
    const socket = new NodeWS.WebSocket(
      `${publicOrigin.origin.replace("http:", "ws:")}/hmr`,
      "vite-hmr",
      { headers: auth },
    );
    cleanups.push(async () => {
      socket.terminate();
      wsServer.close();
    });
    await NodeEvents.EventEmitter.once(socket, "open");
    expect(socket.protocol).toBe("vite-hmr");
    const text = NodeEvents.EventEmitter.once(socket, "message");
    socket.send("update");
    const [message, binary] = await text;
    expect(message.toString()).toBe("update");
    expect(binary).toBe(false);
    const bytes = NodeEvents.EventEmitter.once(socket, "message");
    socket.send(new Uint8Array([1, 2, 3]));
    const [received, isBinary] = await bytes;
    expect([...received]).toEqual([1, 2, 3]);
    expect(isBinary).toBe(true);
    const closed = NodeEvents.EventEmitter.once(socket, "close");
    await close();
    await closed;
  });
});
