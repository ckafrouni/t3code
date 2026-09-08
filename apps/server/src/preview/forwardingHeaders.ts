// @effect-diagnostics nodeBuiltinImport:off -- This adapter preserves raw HTTP streams and WebSocket upgrades.
import type * as NodeHttp from "node:http";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Strip connection-specific headers before crossing the proxy boundary. */
export function forwardingHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
): NodeHttp.IncomingHttpHeaders {
  const excluded = new Set(HOP_BY_HOP_HEADERS);
  for (const name of (headers.connection ?? "").split(",")) {
    excluded.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())),
  );
}

/** Keep application cookies while withholding the gateway's credential. */
export function withoutForwardingCookie(cookie: string | undefined, cookieName: string) {
  return cookie
    ?.split(";")
    .filter((part) => part.slice(0, part.indexOf("=")).trim() !== cookieName)
    .join(";");
}

/** Localhost redirects must continue through the authenticated public origin. */
export function forwardingLocation(location: string, upstream: URL, publicOrigin: URL): string {
  try {
    const target = new URL(location, upstream);
    if (
      target.origin !== upstream.origin &&
      !(
        isLocalLoopbackHost(target.hostname) &&
        target.port === upstream.port &&
        target.protocol === upstream.protocol
      )
    )
      return location;
    const resolved = new URL(publicOrigin);
    resolved.pathname = target.pathname;
    resolved.search = target.search;
    resolved.hash = target.hash;
    return resolved.toString();
  } catch {
    return location;
  }
}
