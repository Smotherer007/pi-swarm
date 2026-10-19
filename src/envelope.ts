/**
 * The sealed envelope every call except /info travels in (pi-swarm/2).
 *
 * A plain request would expose the token in a header, and a token is all a
 * sniffer needs to impersonate a peer. So the token moves *inside* the sealed
 * body: the headers carry only the sender's node id and its public key, which
 * are public anyway. Being able to open the envelope proves possession of the
 * matching private key, which is the authentication.
 *
 * Wire format
 *   request   headers x-swarm-from, x-swarm-pub; body = sealed frame of
 *             {v, rid, ts, token?, body?}
 *             AAD = "pi-swarm/2 req|<METHOD> <path>|<from>><to>"
 *   response  body = sealed frame of the handler's bytes, header x-swarm-sealed
 *             AAD = "pi-swarm/2 res|<status>|<METHOD> <path>|<rid>"
 *
 * What the binding buys:
 *   - the route is authenticated, so a captured body cannot be replayed against
 *     another endpoint, and sender/recipient are authenticated too
 *   - every request carries a random id and a timestamp; the receiver refuses
 *     one it has already seen or one far outside its clock (ReplayGuard)
 *   - the response is bound to the request id and to its status, so an old
 *     answer cannot be replayed into a new call and a denial cannot become an
 *     approval
 *
 * Frames are binary (see crypto.sealFrame): a file travels as its own bytes,
 * not as base64 inside base64.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { ServerResponse } from "node:http";
import * as net from "node:net";

import { openFrame, SEAL_OVERHEAD, sealFrame } from "./crypto.ts";
import type { DirectionKeys } from "./crypto.ts";
import { TransportError } from "./transport.ts";
import { MAX_BODY_BYTES } from "./types.ts";

export const HEADER_FROM = "x-swarm-from";
export const HEADER_PUB = "x-swarm-pub";
export const HEADER_SEALED = "x-swarm-sealed";
export const SEALED_CONTENT_TYPE = "application/x-pi-swarm-sealed";

/** How far a request's clock may be from ours. Generous on purpose: LAN machines drift. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const ENVELOPE_VERSION = 2;
const RID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** What a caller sends: the token rides inside the sealed payload. */
export interface Envelope {
  v: number;
  /** Random request id: replay protection, and what the response is bound to. */
  rid: string;
  /** Sender clock, unix ms. */
  ts: number;
  token?: string;
  body?: unknown;
}

export interface RequestContext {
  method: string;
  /** Path including the query string, exactly as it is sent. */
  path: string;
  /** Node id of the sender. */
  from: string;
  /** Node id of the recipient. */
  to: string;
}

export function requestAad(context: RequestContext): string {
  return `pi-swarm/2 req|${context.method.toUpperCase()} ${context.path}|${context.from}>${context.to}`;
}

export function responseAad(status: number, method: string, path: string, rid: string): string {
  return `pi-swarm/2 res|${status}|${method.toUpperCase()} ${path}|${rid}`;
}

export function newRequestId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function sealRequest(
  keys: DirectionKeys,
  context: RequestContext,
  envelope: Omit<Envelope, "v">,
): Buffer {
  const plaintext = Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, ...envelope }), "utf-8");
  return sealFrame(keys.out, plaintext, requestAad(context));
}

/** Open and shape-check a sealed request. Throws a TransportError on anything wrong. */
export function openRequest(keys: DirectionKeys, context: RequestContext, raw: Buffer): Envelope {
  let plaintext: Buffer;
  try {
    plaintext = openFrame(keys.in, raw, requestAad(context));
  } catch {
    throw new TransportError("the envelope could not be opened (wrong key, wrong route or altered payload)", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf-8"));
  } catch {
    throw new TransportError("the sealed payload is not valid JSON", 400);
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (record.v !== ENVELOPE_VERSION) throw new TransportError("unsupported envelope version", 400);
  if (typeof record.rid !== "string" || !RID_PATTERN.test(record.rid)) {
    throw new TransportError("the envelope carries no valid request id", 400);
  }
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) {
    throw new TransportError("the envelope carries no timestamp", 400);
  }
  return {
    v: ENVELOPE_VERSION,
    rid: record.rid,
    ts: record.ts,
    ...(typeof record.token === "string" && record.token ? { token: record.token } : {}),
    ...(record.body === undefined ? {} : { body: record.body }),
  };
}

/**
 * Refuses a request that was already served, or one whose clock is too far off.
 *
 * Request ids are remembered for twice the allowed skew, which is the longest a
 * captured request could still pass the clock check. Only requests that opened
 * successfully get here, so an attacker without the key cannot fill the cache.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 20_000;
  }

  check(from: string, rid: string, ts: number, now = Date.now()): void {
    const skew = ts - now;
    if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
      throw new TransportError(
        `the request is ${Math.round(Math.abs(skew) / 1000)} s ${skew > 0 ? "ahead of" : "behind"} this node's clock ` +
          `(at most ${MAX_CLOCK_SKEW_MS / 1000} s are allowed); check the system time on both machines`,
        400,
      );
    }
    const key = `${from}|${rid}`;
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) {
      throw new TransportError("this request was already received (replay refused)", 409);
    }
    this.seen.set(key, now + 2 * MAX_CLOCK_SKEW_MS);
    if (this.seen.size > this.maxEntries) this.prune(now);
  }

  private prune(now: number): void {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
    // Still too many live ids: drop the oldest. Map keeps insertion order.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * A response object that seals whatever a handler writes.
 *
 * It implements the methods the handlers use (`writeHead`, `setHeader`, `end`,
 * `headersSent`), so every route keeps its shape while the bytes on the wire are
 * encrypted. Handler headers are not forwarded: everything a handler says is
 * inside the seal.
 */
export class SealedResponse {
  private status = 200;
  private readonly res: ServerResponse;
  private readonly key: Buffer;
  private readonly method: string;
  private readonly path: string;
  private readonly rid: string;

  constructor(res: ServerResponse, keys: DirectionKeys, method: string, path: string, rid: string) {
    this.res = res;
    this.key = keys.out;
    this.method = method;
    this.path = path;
    this.rid = rid;
  }

  get headersSent(): boolean {
    return this.res.headersSent;
  }

  writeHead(status: number, _headers?: Record<string, string>): this {
    this.status = status;
    return this;
  }

  setHeader(_name: string, _value: string): this {
    return this;
  }

  end(body?: Buffer | string): void {
    if (this.res.headersSent) {
      this.res.end();
      return;
    }
    const plaintext = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "", "utf-8");
    const frame = sealFrame(this.key, plaintext, responseAad(this.status, this.method, this.path, this.rid));
    this.res.writeHead(this.status, {
      "content-type": SEALED_CONTENT_TYPE,
      "content-length": String(frame.length),
      "cache-control": "no-store",
      [HEADER_SEALED]: "2",
    });
    this.res.end(frame);
  }
}

export interface SealedRequestOptions {
  method?: "GET" | "POST";
  token?: string | undefined;
  body?: unknown;
  timeoutMs?: number;
  /** Largest plaintext answer accepted. */
  maxBytes?: number;
  /** Return the opened answer as bytes instead of parsing it as JSON. */
  raw?: boolean;
}

export interface SealedIdentity {
  nodeId: string;
  publicKey: string;
}

function reasonFrom(data: unknown, status: number): string {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (typeof record.error === "string") return record.error;
  if (typeof record.reason === "string") return record.reason;
  return `peer answered with status ${status}`;
}

function isIpLiteral(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

/**
 * One authenticated call, sealed in both directions.
 *
 * Behaves like transport.requestJson: a network problem, a timeout, an oversized
 * answer and a non-2xx status all throw a TransportError, the last one with the
 * peer's own reason and status -- so a 401 still triggers the heal path and a 403
 * is still reported as a refusal. A refusal the peer sent before it could open
 * the envelope (wrong key, replay, old protocol) arrives unsealed; it is reported
 * with `unauthenticated` set, because anybody on the path could have written it.
 */
export async function sealedRequest<T = unknown>(
  url: string,
  keys: DirectionKeys,
  from: SealedIdentity,
  to: string,
  options: SealedRequestOptions = {},
): Promise<{ status: number; data: T }> {
  try {
    return await sealedRequestOnce<T>(url, keys, from, to, options);
  } catch (err) {
    // `localhost` is ::1 first on many systems while the peer may listen on
    // IPv4 only; a refused name is retried once over IPv4, like requestJson.
    const error = err as TransportError;
    const worthRetrying =
      error.code === "ECONNREFUSED" ||
      error.code === "EHOSTUNREACH" ||
      error.code === "ENETUNREACH" ||
      error.code === "EADDRNOTAVAIL";
    if (!worthRetrying || isIpLiteral(new URL(url).hostname)) throw error;
    return sealedRequestOnce<T>(url, keys, from, to, options, 4);
  }
}

function sealedRequestOnce<T>(
  url: string,
  keys: DirectionKeys,
  from: SealedIdentity,
  to: string,
  options: SealedRequestOptions,
  family?: 4,
): Promise<{ status: number; data: T }> {
  const method = options.method ?? "POST";
  const parsed = new URL(url);
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  const rid = newRequestId();
  const payload = sealRequest(
    keys,
    { method, path: pathWithQuery, from: from.nodeId, to },
    {
      rid,
      ts: Date.now(),
      ...(options.token ? { token: options.token } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  );
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxWire = (options.maxBytes ?? MAX_BODY_BYTES) + SEAL_OVERHEAD;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: TransportError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port,
        path: pathWithQuery,
        method,
        headers: {
          "content-type": SEALED_CONTENT_TYPE,
          "content-length": String(payload.length),
          accept: SEALED_CONTENT_TYPE,
          [HEADER_FROM]: from.nodeId,
          [HEADER_PUB]: from.publicKey,
        },
        agent: false,
        ...(family ? { family } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxWire) {
            req.destroy();
            fail(new TransportError(`response exceeds ${maxWire - SEAL_OVERHEAD} bytes`, res.statusCode));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => fail(new TransportError(err.message, res.statusCode)));
        res.on("end", () => {
          if (settled) return;
          const raw = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;

          if (!res.headers[HEADER_SEALED]) {
            // Only a refusal may arrive in clear text; a success never does.
            let data: unknown;
            try {
              data = raw.length > 0 ? JSON.parse(raw.toString("utf-8")) : undefined;
            } catch {
              data = undefined;
            }
            const error = new TransportError(
              status >= 400 ? reasonFrom(data, status) : "the answer was not sealed",
              status >= 400 ? status : 502,
            );
            error.unauthenticated = true;
            fail(error);
            return;
          }

          let plaintext: Buffer;
          try {
            plaintext = openFrame(keys.in, raw, responseAad(status, method, pathWithQuery, rid));
          } catch {
            fail(new TransportError("the answer could not be opened (wrong key or altered payload)", 502));
            return;
          }

          let data: unknown;
          if (options.raw && status >= 200 && status < 300) {
            data = plaintext;
          } else {
            try {
              data = plaintext.length > 0 ? JSON.parse(plaintext.toString("utf-8")) : undefined;
            } catch {
              fail(new TransportError(`the sealed answer is not valid JSON (status ${status})`, status));
              return;
            }
          }
          if (status < 200 || status >= 300) {
            fail(new TransportError(reasonFrom(data, status), status));
            return;
          }
          settled = true;
          resolve({ status, data: data as T });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fail(new TransportError(`peer did not answer within ${timeoutMs} ms`));
    });
    req.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      fail(new TransportError(code ? `${err.message} (${code})` : err.message, undefined, code));
    });
    req.end(payload);
  });
}

/**
 * Fetch an offered file through a sealed call and write it to disk.
 *
 * The answer is authenticated before a single byte is written, so a payload
 * that was altered on the way never touches the disk. The byte limit is the
 * receiver's, not the size the sender announced; the caller still compares the
 * sha256 with the one from the offer.
 */
export async function sealedDownloadToFile(
  url: string,
  keys: DirectionKeys,
  from: SealedIdentity,
  to: string,
  destPath: string,
  options: { token?: string | undefined; maxBytes: number; timeoutMs?: number },
): Promise<{ bytes: number; sha256: string }> {
  const { data } = await sealedRequest<Buffer>(url, keys, from, to, {
    method: "GET",
    token: options.token,
    raw: true,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
  if (bytes.length > options.maxBytes) {
    throw new TransportError(`file exceeds ${options.maxBytes} bytes`, 413);
  }
  fs.writeFileSync(destPath, bytes, { mode: 0o600 });
  return { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
