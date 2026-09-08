// @effect-diagnostics nodeBuiltinImport:off -- This adapter preserves raw HTTP streams and WebSocket upgrades.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeStream from "node:stream";
import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";

import {
  forwardingHeaders,
  forwardingLocation,
  withoutForwardingCookie,
} from "./forwardingHeaders.ts";

export interface PortForwardProxyOptions {
  readonly upstream: URL;
  readonly publicOrigin: () => URL;
  readonly cookieName: string;
  readonly privateCookieNames?: ReadonlyArray<string>;
  readonly authorize: (request: NodeHttp.IncomingMessage) => boolean;
  readonly handleGatewayRequest: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => boolean;
}

/** One dedicated origin forwards one service, preserving root paths and WebSockets. */
export function createPortForwardProxy(options: PortForwardProxyOptions) {
  const sockets = new Set<NodeStream.Duplex>();
  const transport = options.upstream.protocol === "https:" ? NodeHttps : NodeHttp;
  const track = (socket: NodeStream.Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const requestOptions = (request: NodeHttp.IncomingMessage) => {
    const headers = forwardingHeaders(request.headers);
    // Preview origins never receive T3's bearer token; preserve the app's own Authorization.
    delete headers.dpop;
    for (const name of Object.keys(headers)) {
      if (name.startsWith("x-forwarded-") || name.startsWith("cf-") || name === "forwarded") {
        delete headers[name];
      }
    }
    headers.host = options.upstream.host;
    const cookie = [options.cookieName, ...(options.privateCookieNames ?? [])]
      .reduce((value, name) => withoutForwardingCookie(value, name), headers.cookie)
      ?.split(";")
      .filter((part) => !part.trim().startsWith("t3_preview_"))
      .join(";");
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    const origin = options.publicOrigin();
    headers["x-forwarded-host"] = origin.host;
    headers["x-forwarded-proto"] = origin.protocol.slice(0, -1);
    if (headers.origin === origin.origin) headers.origin = options.upstream.origin;
    return {
      protocol: options.upstream.protocol,
      hostname: options.upstream.hostname.replace(/^\[|\]$/g, ""),
      port: options.upstream.port,
      method: request.method,
      // Do not resolve request URLs: //host and absolute URLs must never change the target.
      path: request.url?.startsWith("/") ? request.url : "/",
      headers,
      timeout: 30_000,
    };
  };
  const responseHeaders = (headers: NodeHttp.IncomingHttpHeaders) => {
    const forwarded = forwardingHeaders(headers);
    if (forwarded.location) {
      forwarded.location = forwardingLocation(
        forwarded.location,
        options.upstream,
        options.publicOrigin(),
      );
    }
    if (forwarded["set-cookie"]) {
      forwarded["set-cookie"] = forwarded["set-cookie"]
        .filter((cookie) => {
          const name = cookie.slice(0, cookie.indexOf("=")).trim();
          return (
            name !== options.cookieName &&
            !name.startsWith("t3_preview_") &&
            !options.privateCookieNames?.includes(name)
          );
        })
        .map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ""));
    }
    // An authenticated response must not become publicly reusable at the tunnel edge.
    forwarded["cache-control"] = "private, no-store";
    forwarded["referrer-policy"] = "no-referrer";
    return forwarded;
  };
  const server = guardHttpResponseWriteErrors(
    NodeHttp.createServer((request, response) => {
      if (options.handleGatewayRequest(request, response)) return;
      if (!options.authorize(request)) {
        response.writeHead(401, { "cache-control": "no-store", "content-type": "text/plain" });
        response.end("Open this service from T3 Code to sign in.");
        return;
      }
      const upstream = transport.request(requestOptions(request), (incoming) => {
        upstream.setTimeout(0);
        response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      });
      upstream.on("socket", track);
      upstream.on("timeout", () => upstream.destroy(new Error("Preview service timed out")));
      upstream.on("error", () => {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(502, { "cache-control": "no-store", "content-type": "text/plain" });
          response.end(
            "The forwarded service is unavailable. Check that your dev server is running.",
          );
        }
      });
      request.on("aborted", () => upstream.destroy());
      request.on("error", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    }),
  );
  server.on("connection", track);
  server.on("upgrade", (request, socket, head) => {
    if (!options.authorize(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const init = requestOptions(request);
    init.headers.connection = "Upgrade";
    init.headers.upgrade = "websocket";
    const upstream = transport.request(init);
    upstream.on("socket", track);
    upstream.on("timeout", () => upstream.destroy(new Error("Preview service timed out")));
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (response) => {
      response.resume();
      socket.end(
        `HTTP/1.1 ${response.statusCode ?? 502} Upgrade Failed\r\nConnection: close\r\n\r\n`,
      );
    });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      track(peer);
      peer.setTimeout(0);
      const headers = responseHeaders(response.headers);
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      for (const [name, values] of Object.entries(headers)) {
        for (const value of Array.isArray(values) ? values : [values]) {
          if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy());
      peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });
  return {
    server,
    disconnect: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
