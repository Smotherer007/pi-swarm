/**
 * Wire format: validation of everything that arrives over HTTP.
 *
 * Anything from another node is untrusted input. It is validated for shape and
 * size here, stripped of control characters, and never interpreted as an
 * instruction by the extension. Content that reaches the model is labelled as
 * third-party data.
 */

import type {
  KnowledgeEntry,
  KnowledgeKind,
  MessageKind,
  PeerRef,
  Scope,
} from "./types.ts";
import {
  KNOWLEDGE_KINDS,
  MAX_KEY_LENGTH,
  MAX_KNOWLEDGE_TEXT,
  MAX_TEXT_LENGTH,
  PROTOCOL,
} from "./types.ts";
import { normalizeScopes } from "./permissions.ts";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${field} must be a string.`);
  const text = sanitizeText(value, maxLength);
  if (!text) fail(`${field} must not be empty.`);
  return text;
}

function asOptionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string.`);
  const text = sanitizeText(value, maxLength);
  return text || undefined;
}

/**
 * Collapse control characters (a terminal escape or a NUL byte has no business
 * in a peer message) and cap the length. Newlines and tabs survive.
 */
export function sanitizeText(raw: string, maxLength: number): string {
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "chat" || value === "note" || value === "question" || value === "answer";
}

export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === "string" && (KNOWLEDGE_KINDS as readonly string[]).includes(value);
}

export function parsePeerRef(value: unknown, field: string): PeerRef {
  const record = asRecord(value, field);
  const nodeId = asString(record.nodeId, `${field}.nodeId`, 80);
  if (!/^[A-Za-z0-9._:-]+$/.test(nodeId)) fail(`${field}.nodeId has invalid characters.`);
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${field}.port must be an integer between 1 and 65535.`);
  }
  return {
    nodeId,
    name: asOptionalString(record.name, `${field}.name`, 64) ?? "unknown",
    host: asOptionalString(record.host, `${field}.host`, 255) ?? "",
    port,
  };
}

export interface HelloRequest {
  from: { nodeId: string; name: string };
  sessionId: string | null;
  scopes: Scope[];
  intent: string;
  message?: string;
  port: number;
  /** Set on a retry: the request id the peer already gave us, so it resumes. */
  requestId?: string;
}

export function parseHello(value: unknown): HelloRequest {
  const record = asRecord(value, "body");
  if (typeof record.proto === "string" && record.proto !== PROTOCOL) {
    fail(`unsupported protocol "${record.proto}", this node speaks ${PROTOCOL}.`);
  }
  const from = asRecord(record.from, "from");
  const nodeId = asString(from.nodeId, "from.nodeId", 80);
  if (!/^[A-Za-z0-9._:-]+$/.test(nodeId)) fail("from.nodeId has invalid characters.");
  const scopes = normalizeScopes(record.scopes);
  if (scopes.length === 0) fail("scopes must list at least one valid scope.");
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail("port must be the TCP port this node listens on (1-65535).");
  }
  const sessionId = record.sessionId === null || record.sessionId === undefined
    ? null
    : asString(record.sessionId, "sessionId", 80);

  return {
    from: { nodeId, name: asOptionalString(from.name, "from.name", 64) ?? "unknown" },
    sessionId,
    scopes,
    intent: asOptionalString(record.intent, "intent", 200) ?? "connect",
    message: asOptionalString(record.message, "message", 2000),
    port,
    requestId: asOptionalString(record.requestId, "requestId", 80),
  };
}

export function parseApproval(value: unknown): { requestId: string } {
  const record = asRecord(value, "body");
  return { requestId: asString(record.requestId, "requestId", 80) };
}

export interface IncomingMessage {
  id: string;
  text: string;
  kind: MessageKind;
  sessionId: string | null;
}

export function parseMessage(value: unknown): IncomingMessage {
  const record = asRecord(value, "body");
  const text = asString(record.text, "text", MAX_TEXT_LENGTH);
  return {
    id: asOptionalString(record.id, "id", 80) ?? `m_${Date.now().toString(36)}`,
    text,
    kind: isMessageKind(record.kind) ? record.kind : "chat",
    sessionId: asOptionalString(record.sessionId, "sessionId", 80) ?? null,
  };
}

export function parseKnowledgePush(value: unknown): KnowledgeEntry[] {
  const record = asRecord(value, "body");
  if (!Array.isArray(record.entries)) fail("entries must be an array.");
  if (record.entries.length === 0) return [];
  const entries: KnowledgeEntry[] = [];
  for (const item of record.entries) {
    const entry = asRecord(item, "entries[]");
    const id = asString(entry.id, "entries[].id", 160);
    const key = asOptionalString(entry.key, "entries[].key", MAX_KEY_LENGTH) ?? "";
    if (!isKnowledgeKind(entry.kind)) fail("entries[].kind is not a known knowledge kind.");
    const author = asRecord(entry.author, "entries[].author");
    const ts = entry.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
      fail("entries[].ts must be a unix timestamp in ms.");
    }
    entries.push({
      id,
      sessionId: asOptionalString(entry.sessionId, "entries[].sessionId", 80) ?? "",
      key,
      kind: entry.kind,
      text: asString(entry.text, "entries[].text", MAX_KNOWLEDGE_TEXT),
      author: {
        nodeId: asString(author.nodeId, "entries[].author.nodeId", 80),
        name: asOptionalString(author.name, "entries[].author.name", 64) ?? "unknown",
      },
      ts,
    });
  }
  return entries;
}

export function parseIntroductions(value: unknown): PeerRef[] {
  const record = asRecord(value, "body");
  if (!Array.isArray(record.peers)) fail("peers must be an array.");
  return record.peers.slice(0, 32).map((peer) => parsePeerRef(peer, "peers[]"));
}

/**
 * Label content that came from another agent. Every tool result that contains
 * peer text goes through this: the model must be able to tell the user's words
 * from a stranger's words.
 */
export function labelPeerContent(name: string, nodeId: string): string {
  return `[peer ${shortId(nodeId)} ${name}]`;
}

export function shortId(nodeId: string): string {
  return nodeId.length > 10 ? nodeId.slice(0, 10) : nodeId;
}
