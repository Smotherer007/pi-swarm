/**
 * HTTP transport: one small server and a strict JSON client.
 *
 * Both sides of the swarm speak JSON over HTTP/1.1. The client refuses to wait
 * forever, refuses oversized answers, and turns a non-2xx status into an error
 * carrying the peer's own reason.
 */

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { MAX_BODY_BYTES } from "./types.ts";

export class TransportError extends Error {
  statusCode: number | undefined;
  /** Socket error code (ECONNREFUSED, EHOSTUNREACH, ...) when the call never
   *  reached the peer. Undefined when the peer answered with a status. */
  code: string | undefined;

  constructor(message: string, statusCode?: number, code?: string) {
    super(message);
    this.name = "TransportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => Promise<void> | void;

/**
 * Read at most `limit` bytes of a request body.
 *
 * An oversized body is drained up to a hard limit and then reported as 413, so
 * the peer receives a real answer instead of a reset socket. Beyond that the
 * connection is cut: a peer that ignores the limit does not get to hold the
 * socket open.
 */
export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const hardLimit = limit * 4;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const fail = (err: TransportError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        if (size > hardLimit) req.destroy();
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        fail(new TransportError(`request body exceeds ${limit} bytes`, 413));
        return;
      }
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => fail(new TransportError(err.message, 400)));
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

export interface StartServerOptions {
  port: number;
  host: string;
  handler: HttpHandler;
}

/**
 * Start the swarm endpoint. A port already in use is reported as an error so
 * the caller can decide to fall back to an ephemeral port -- two pi instances
 * on one machine must be able to coexist.
 */
export function startHttpServer(options: StartServerOptions): Promise<HttpServerHandle> {
  // "0.0.0.0" means "reachable", not "IPv4 only": on a dual-stack host bind
  // "::" so a peer that resolves localhost to ::1 (common on Windows and on
  // modern Linux) still connects. Fall back to IPv4 when IPv6 is unavailable.
  const candidates = options.host === "0.0.0.0" ? ["::", "0.0.0.0"] : [options.host];
  return listenOn(candidates, 0, options);
}

function listenOn(
  candidates: string[],
  index: number,
  options: StartServerOptions,
): Promise<HttpServerHandle> {
  const host = candidates[index];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      readBody(req)
        .then((body) => options.handler(req, res, body))
        .catch((err: unknown) => {
          const status = err instanceof TransportError && err.statusCode ? err.statusCode : 400;
          if (!res.headersSent) {
            sendJson(res, status, { error: err instanceof Error ? err.message : "bad request" });
          } else {
            res.end();
          }
        });
    });

    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;

    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      server.close(() => {});
      const familyMissing =
        err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT" || err.code === "EINVAL";
      if (familyMissing && index + 1 < candidates.length) {
        resolve(listenOn(candidates, index + 1, options));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo | null;
      resolve({
        port: address?.port ?? options.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port: options.port, host, ipv6Only: false });
  });
}

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface JsonResponse<T> {
  status: number;
  data: T;
}

function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function baseUrl(host: string, port: number): string {
  return `http://${formatHost(host)}:${port}`;
}

/**
 * Perform one JSON request. Throws TransportError on a network problem, a
 * timeout, an oversized answer, or a non-2xx status; the peer's `error` field
 * becomes the message in the last case.
 */
function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return net.isIP(bare) !== 0;
}

/**
 * A hostname may resolve to an address family the peer does not listen on:
 * `localhost` is ::1 first on many systems, while a node bound to IPv4 is not
 * there. A refused name is retried once over IPv4 before giving up.
 */
export async function requestJson<T = unknown>(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse<T>> {
  try {
    return await requestOnce<T>(url, options);
  } catch (err) {
    const error = err as TransportError;
    const hostname = new URL(url).hostname;
    const worthRetrying =
      error.code === "ECONNREFUSED" ||
      error.code === "EHOSTUNREACH" ||
      error.code === "ENETUNREACH" ||
      error.code === "EADDRNOTAVAIL";
    if (!worthRetrying || isIpLiteral(hostname)) throw error;
    return requestOnce<T>(url, options, 4);
  }
}

function requestOnce<T>(
  url: string,
  options: JsonRequestOptions,
  family?: 4 | 6,
): Promise<JsonResponse<T>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf-8");

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }

    // URL.hostname keeps the brackets of an IPv6 literal, http.request does
    // not want them.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? (payload ? "POST" : "GET"),
        headers,
        agent: false,
        ...(family ? { family } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new TransportError(`response exceeds ${maxBytes} bytes`, res.statusCode));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf-8");
          let data: unknown = undefined;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              reject(new TransportError(`response was not JSON (status ${status})`, status));
              return;
            }
          }
          if (status < 200 || status >= 300) {
            // A peer explains itself in `error` or in `reason`; both are its
            // own words and belong in the error the caller sees.
            const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
            const reason =
              typeof record.error === "string"
                ? record.error
                : typeof record.reason === "string"
                  ? record.reason
                  : `peer answered with status ${status}`;
            reject(new TransportError(reason, status));
            return;
          }
          resolve({ status, data: data as T });
        });
        res.on("error", (err) => reject(new TransportError(err.message, res.statusCode)));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new TransportError(`peer did not answer within ${timeoutMs} ms`));
    });
    req.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new TransportError(code ? `${err.message} (${code})` : err.message, undefined, code),
      );
    });
    if (payload) req.write(payload);
    req.end();
  });
}
