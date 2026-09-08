// @effect-diagnostics nodeBuiltinImport:off -- Exercise real loopback listeners without relying on wildcard localhost DNS.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { LocalPortForwards } from "./LocalPortForwards.ts";

const managers: LocalPortForwards[] = [];
const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function manager(now?: () => number) {
  const value = new LocalPortForwards({ reservedPorts: [16250, 8210], ...(now ? { now } : {}) });
  managers.push(value);
  return value;
}

async function service() {
  const server = NodeHttp.createServer((request, response) =>
    response.end(`served ${request.url}`),
  );
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return address.port;
}

function request(
  url: string,
  options: { method?: string; headers?: NodeHttp.OutgoingHttpHeaders } = {},
) {
  const target = new URL(url);
  return new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const outgoing = NodeHttp.request(
        {
          agent: false,
          hostname: "127.0.0.1",
          port: target.port,
          path: target.pathname + target.search,
          method: options.method ?? "GET",
          headers: { host: target.host, ...options.headers },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    },
  );
}

async function redeem(openUrl: string, origin?: string) {
  const url = new URL(openUrl);
  return request(`${url.origin}/__t3_preview/session`, {
    method: "POST",
    headers: {
      origin: origin ?? url.origin,
      "x-t3-preview-ticket": url.hash.slice(1),
    },
  });
}

describe("local port forwards", () => {
  it("uses a one-time ticket and a scoped HttpOnly cookie to reach the service", async () => {
    const value = manager();
    const port = await service();
    const snapshot = await value.start(port, "http");
    const preview = snapshot.forwards[0]!.previewUrl;
    expect(new URL(preview).hostname).toMatch(/^preview-\d+\.localhost$/);
    expect((await request(preview)).status).toBe(401);
    const link = value.open(port, "owner").openUrl;
    const bootstrap = await request(link);
    expect(bootstrap.body).toContain("history.replaceState");
    expect(bootstrap.body).not.toContain(new URL(link).hash.slice(1));
    const session = await redeem(link);
    expect(session.status).toBe(204);
    const cookie = session.headers["set-cookie"]![0]!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    const response = await request(`${preview}/nested?x=1`, {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(response).toMatchObject({ status: 200, body: "served /nested?x=1" });
    expect((await redeem(link)).status).toBe(401);
  });

  it("rejects expired tickets and sessions", async () => {
    let now = 0;
    const value = manager(() => now);
    const port = await service();
    await value.start(port, "http");
    const expiredLink = value.open(port, "owner").openUrl;
    now = 60_001;
    expect((await redeem(expiredLink)).status).toBe(401);
    const link = value.open(port, "owner", now + 1000).openUrl;
    const session = await redeem(link);
    now += 1001;
    expect(
      (
        await request(new URL(link).origin, {
          headers: { cookie: session.headers["set-cookie"]![0]!.split(";")[0] },
        })
      ).status,
    ).toBe(401);
  });

  it("revokes both open tickets and browser sessions when their T3 session is revoked", async () => {
    const value = manager();
    const port = await service();
    await value.start(port, "http");
    const link = value.open(port, "owner").openUrl;
    const session = await redeem(link);
    const pending = value.open(port, "owner").openUrl;
    const other = value.open(port, "another-owner").openUrl;
    value.revokeOwner("owner");
    expect((await redeem(pending)).status).toBe(401);
    expect(
      (
        await request(new URL(link).origin, {
          headers: { cookie: session.headers["set-cookie"]![0]!.split(";")[0] },
        })
      ).status,
    ).toBe(401);
    expect((await redeem(other)).status).toBe(204);
  });

  it("rejects a different origin or host without consuming a legitimate ticket", async () => {
    const value = manager();
    const port = await service();
    await value.start(port, "http");
    const link = value.open(port, "owner").openUrl;
    expect((await redeem(link, "http://attacker.invalid")).status).toBe(403);
    expect((await request(link, { headers: { host: "attacker.invalid" } })).status).toBe(403);
    expect((await redeem(link)).status).toBe(204);
  });

  it("publishes state, deduplicates starts, stops access, and permits restarting", async () => {
    const value = manager();
    const port = await service();
    const counts: number[] = [];
    const unsubscribe = value.subscribe((state) => counts.push(state.forwards.length));
    const first = await value.start(port, "http");
    expect(await value.start(port, "http")).toEqual(first);
    const link = value.open(port, "owner").openUrl;
    await value.stop(port);
    await expect(request(link)).rejects.toThrow();
    expect(() => value.open(port, "owner")).toThrow("not forwarded");
    await value.start(port, "http");
    expect(counts).toEqual([0, 1, 0, 1]);
    unsubscribe();
  });

  it("rejects reserved ports, proxy loops, and protocol changes", async () => {
    const value = manager();
    for (const port of [0, -1, 1.5, 65536, 16250, 8210])
      await expect(value.start(port, "http")).rejects.toThrow("valid dev-server port");
    const port = await service();
    const state = await value.start(port, "http");
    await expect(
      value.start(Number(new URL(state.forwards[0]!.previewUrl).port), "http"),
    ).rejects.toThrow("valid dev-server port");
    await expect(value.start(port, "https")).rejects.toThrow("changing its protocol");
  });

  it("bounds listeners and pending credentials", async () => {
    const value = manager();
    for (let port = 20000; port < 20008; port++) await value.start(port, "http");
    await expect(value.start(20008, "http")).rejects.toThrow("maximum eight");
    for (let index = 0; index < 256; index++) value.open(20000, "owner");
    expect(() => value.open(20000, "owner")).toThrow("Too many preview sessions");
  });

  it("does not leave a listener alive if shutdown races with starting it", async () => {
    const value = manager();
    const pending = value.start(3000, "http");
    await value.close();
    await expect(pending).rejects.toThrow("has stopped");
    expect(value.snapshot().forwards).toEqual([]);
  });
});
