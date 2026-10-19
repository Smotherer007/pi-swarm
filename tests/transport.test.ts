/**
 * Transport behaviour that differs between operating systems: address
 * families, bracketed IPv6 literals, port collisions and oversized bodies.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import {
  baseUrl,
  requestJson,
  sendJson,
  startHttpServer,
  TransportError,
} from "../src/transport.ts";
import type { HttpServerHandle } from "../src/transport.ts";

const servers: HttpServerHandle[] = [];

after(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {});
});

async function simpleServer(port = 0, host = "127.0.0.1"): Promise<HttpServerHandle> {
  const handle = await startHttpServer({
    port,
    host,
    handler: (req, res, body) => {
      if (req.url === "/big") {
        sendJson(res, 200, { size: body.length });
        return;
      }
      if (req.url === "/secret") {
        if (req.headers.authorization !== "Bearer ok") {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 200, { ok: true, url: req.url });
    },
  });
  servers.push(handle);
  return handle;
}

describe("baseUrl", () => {
  it("brackets IPv6 literals and leaves everything else alone", () => {
    assert.equal(baseUrl("127.0.0.1", 47823), "http://127.0.0.1:47823");
    assert.equal(baseUrl("pi.local", 47823), "http://pi.local:47823");
    assert.equal(baseUrl("fd00::1", 47823), "http://[fd00::1]:47823");
    assert.equal(baseUrl("[fd00::1]", 47823), "http://[fd00::1]:47823");
  });
});

describe("startHttpServer", () => {
  it("picks a free port when asked for port 0", async () => {
    const a = await simpleServer();
    const b = await simpleServer();
    assert.ok(a.port > 0 && b.port > 0);
    assert.notEqual(a.port, b.port);
  });

  it("reports a taken port as EADDRINUSE", async () => {
    const first = await simpleServer();
    await assert.rejects(
      startHttpServer({
        port: first.port,
        host: "127.0.0.1",
        handler: () => {},
      }),
      (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE",
    );
  });

  it("answers over localhost even when it resolves to the other family", async () => {
    const server = await simpleServer();
    // On a dual-stack host, localhost may resolve to ::1 while the server
    // listens on 127.0.0.1; requestJson retries over IPv4.
    const response = await requestJson<{ ok: boolean }>(
      `http://localhost:${server.port}/info`,
      { timeoutMs: 4000 },
    );
    assert.equal(response.data.ok, true);
  });
});

describe("requestJson", () => {
  it("sends JSON and parses the answer", async () => {
    const server = await simpleServer();
    const response = await requestJson<{ url: string }>(
      `${baseUrl("127.0.0.1", server.port)}/hello?x=1`,
      { body: { a: 1 } },
    );
    assert.equal(response.data.url, "/hello?x=1");
  });

  it("turns a peer's own error text into the error message", async () => {
    const server = await simpleServer();
    await assert.rejects(
      requestJson(`${baseUrl("127.0.0.1", server.port)}/secret`),
      (err: TransportError) => err.statusCode === 401 && /token/.test(err.message),
    );
  });

  it("carries the error code for a closed port", async () => {
    await assert.rejects(
      requestJson("http://127.0.0.1:1/info", { timeoutMs: 2000 }),
      (err: TransportError) => err.code === "ECONNREFUSED" || /ECONNREFUSED/.test(err.message),
    );
  });

  it("accepts a bracketed IPv6 literal without a lookup", async () => {
    // Whether ::1 exists is up to the host; what must not happen is a name
    // lookup for "[::1]".
    await assert.rejects(
      requestJson("http://[::1]:1/info", { timeoutMs: 1500 }),
      (err: TransportError) => !/ENOTFOUND/.test(err.message),
    );
  });

  it("rejects an oversized request body with 413", async () => {
    const server = await simpleServer();
    await assert.rejects(
      requestJson(`${baseUrl("127.0.0.1", server.port)}/big`, {
        body: { text: "x".repeat(600 * 1024) },
      }),
      (err: TransportError) => err.statusCode === 413,
    );
  });
});
