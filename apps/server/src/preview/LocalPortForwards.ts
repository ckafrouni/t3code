// @effect-diagnostics nodeBuiltinImport:off -- Node owns the local proxy listeners and their lifecycle.
// @effect-diagnostics globalDate:off -- Credential expiry is injected in tests at this Node boundary.
// @effect-diagnostics globalTimers:off -- Each bounded preview session owns and clears one expiry timer.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import { PortForwardError, type ForwardedPort, type PortForwardSnapshot } from "@t3tools/contracts";
import { createPortForwardProxy } from "./PortForwardProxy.ts";

const MAX_FORWARDS = 8;
const MAX_CREDENTIALS = 256;
const TICKET_TTL = 60_000;
const SESSION_TTL = 8 * 60 * 60_000;
const BOOTSTRAP_PATH = "/__t3_preview/open";
const SESSION_PATH = "/__t3_preview/session";

const bootstrapHtml = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening preview</title><p id="status">Opening your preview…</p><script>
const ticket = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
fetch('${SESSION_PATH}', {method:'POST', headers:{'x-t3-preview-ticket':ticket}})
  .then(response => { if (!response.ok) throw new Error(); location.replace('/'); })
  .catch(() => { document.getElementById('status').textContent = 'This preview link expired or was already used. Open the service again from T3 Code.'; });
</script>`;

interface Grant {
  readonly owner: string;
  readonly expiresAt: number;
  readonly ownerExpiresAt?: number;
}
interface Session extends Grant {
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Entry {
  readonly snapshot: ForwardedPort;
  readonly proxy: ReturnType<typeof createPortForwardProxy>;
  readonly tickets: Map<string, Grant>;
  readonly sessions: Map<string, Session>;
}

/** Server-lifetime local transport. A managed hostname transport can replace the listener later. */
export class LocalPortForwards {
  private readonly entries = new Map<number, Entry>();
  private readonly listeners = new Set<(snapshot: PortForwardSnapshot) => void>();
  private readonly reservedPorts: ReadonlyArray<number>;
  private readonly privateCookieNames: ReadonlyArray<string>;
  private readonly now: () => number;
  private closed = false;

  constructor(options: {
    reservedPorts: ReadonlyArray<number>;
    privateCookieNames?: ReadonlyArray<string>;
    now?: () => number;
  }) {
    this.reservedPorts = options.reservedPorts;
    this.privateCookieNames = options.privateCookieNames ?? [];
    this.now = options.now ?? Date.now;
  }

  snapshot(): PortForwardSnapshot {
    return {
      mode: "local",
      reservedPorts: this.reservedPorts.filter((port) => port > 0),
      forwards: [...this.entries.values()]
        .map((entry) => entry.snapshot)
        .sort((a, b) => a.port - b.port),
    };
  }

  subscribe(listener: (snapshot: PortForwardSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  async start(port: number, protocol: "http" | "https") {
    if (this.closed) throw new PortForwardError({ message: "Port forwarding has stopped." });
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      this.reservedPorts.includes(port) ||
      [...this.entries.values()].some(
        (entry) => Number(new URL(entry.snapshot.previewUrl).port) === port,
      )
    ) {
      throw new PortForwardError({
        message: "Choose a valid dev-server port, other than a T3 or preview port.",
      });
    }
    const existing = this.entries.get(port);
    if (existing) {
      if (existing.snapshot.protocol !== protocol)
        throw new PortForwardError({ message: "Stop this forward before changing its protocol." });
      return this.snapshot();
    }
    if (this.entries.size >= MAX_FORWARDS)
      throw new PortForwardError({
        message: "Stop an existing forward before adding another (maximum eight).",
      });
    const tickets = new Map<string, Grant>();
    const sessions = new Map<string, Session>();
    const cookieName = `t3_preview_${NodeCrypto.randomBytes(12).toString("hex")}`;
    let origin = new URL("http://localhost");
    const validHost = (request: NodeHttp.IncomingMessage) => request.headers.host === origin.host;
    const proxy = createPortForwardProxy({
      upstream: new URL(`${protocol}://localhost:${port}`),
      publicOrigin: () => origin,
      cookieName,
      privateCookieNames: this.privateCookieNames,
      authorize: (request) => {
        if (!validHost(request)) return false;
        if (request.headers.origin && request.headers.origin !== origin.origin) return false;
        const cookie = request.headers.cookie
          ?.split(";")
          .map((value) => value.trim())
          .find((value) => value.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const session = cookie ? sessions.get(cookie) : undefined;
        return session !== undefined && session.expiresAt > this.now();
      },
      handleGatewayRequest: (request, response) => {
        if (!request.url?.startsWith("/__t3_preview/")) return false;
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        if (!validHost(request)) {
          response.writeHead(403);
          response.end();
          return true;
        }
        if (request.method === "GET" && request.url === BOOTSTRAP_PATH) {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader(
            "content-security-policy",
            "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          );
          response.end(bootstrapHtml);
          return true;
        }
        if (
          request.method !== "POST" ||
          request.url !== SESSION_PATH ||
          request.headers.origin !== origin.origin
        ) {
          response.writeHead(403);
          response.end();
          return true;
        }
        const token = request.headers["x-t3-preview-ticket"];
        const ticket = typeof token === "string" ? tickets.get(token) : undefined;
        if (typeof token === "string") tickets.delete(token);
        if (!ticket || ticket.expiresAt <= this.now() || sessions.size >= MAX_CREDENTIALS) {
          response.writeHead(401);
          response.end();
          return true;
        }
        const sessionToken = NodeCrypto.randomBytes(32).toString("base64url");
        const timer = setTimeout(
          () => {
            sessions.delete(sessionToken);
            proxy.disconnect();
          },
          Math.min(SESSION_TTL, (ticket.ownerExpiresAt ?? Infinity) - this.now()),
        );
        timer.unref();
        sessions.set(sessionToken, {
          owner: ticket.owner,
          expiresAt: Math.min(this.now() + SESSION_TTL, ticket.ownerExpiresAt ?? Infinity),
          timer,
        });
        response.setHeader(
          "set-cookie",
          `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`,
        );
        response.writeHead(204);
        response.end();
        return true;
      },
    });
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", () => {
        proxy.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = proxy.server.address();
    if (this.closed) {
      await proxy.close();
      throw new PortForwardError({ message: "Port forwarding has stopped." });
    }
    if (!address || typeof address === "string") {
      await proxy.close();
      throw new PortForwardError({ message: "Could not open the local preview listener." });
    }
    // Using a different hostname as well as port keeps preview cookies separate from T3.
    origin = new URL(`http://preview-${address.port}.localhost:${address.port}`);
    this.entries.set(port, {
      snapshot: { port, protocol, previewUrl: origin.origin },
      proxy,
      tickets,
      sessions,
    });
    this.publish();
    return this.snapshot();
  }

  open(port: number, owner: string, ownerExpiresAt?: number) {
    const entry = this.entries.get(port);
    if (!entry)
      throw new PortForwardError({
        message: "This port is not forwarded. Start forwarding it first.",
      });
    for (const [token, ticket] of entry.tickets)
      if (ticket.expiresAt <= this.now()) entry.tickets.delete(token);
    if (entry.tickets.size >= MAX_CREDENTIALS || entry.sessions.size >= MAX_CREDENTIALS)
      throw new PortForwardError({
        message: "Too many preview sessions. Stop and restart the forward to reset access.",
      });
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    entry.tickets.set(token, {
      owner,
      expiresAt: Math.min(this.now() + TICKET_TTL, ownerExpiresAt ?? Infinity),
      ...(ownerExpiresAt === undefined ? {} : { ownerExpiresAt }),
    });
    return {
      ...this.snapshot(),
      openUrl: `${entry.snapshot.previewUrl}${BOOTSTRAP_PATH}#${token}`,
    };
  }

  revokeOwner(owner: string) {
    for (const entry of this.entries.values()) {
      for (const [token, ticket] of entry.tickets)
        if (ticket.owner === owner) entry.tickets.delete(token);
      let disconnected = false;
      for (const [token, session] of entry.sessions)
        if (session.owner === owner) {
          clearTimeout(session.timer);
          entry.sessions.delete(token);
          disconnected = true;
        }
      if (disconnected) entry.proxy.disconnect();
    }
  }

  async stop(port: number) {
    const entry = this.entries.get(port);
    if (!entry) return this.snapshot();
    this.entries.delete(port);
    entry.tickets.clear();
    for (const session of entry.sessions.values()) clearTimeout(session.timer);
    entry.sessions.clear();
    await entry.proxy.close();
    this.publish();
    return this.snapshot();
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((port) => this.stop(port)));
    this.listeners.clear();
  }
}
