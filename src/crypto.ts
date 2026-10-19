/**
 * Application-level encryption for the swarm transport.
 *
 * Plain HTTP over a LAN means a sniffer reads every message, every knowledge
 * entry and every file -- and a bearer token, which is enough to impersonate a
 * peer. TLS would fix the wire but needs certificates, and `node:crypto` cannot
 * sign one. So the payload is sealed instead, with keys the two nodes derive
 * themselves:
 *
 *   1. every node has a long-term X25519 keypair, created with its identity
 *   2. the public half travels with the beacon, /info and every sealed request
 *   3. both sides compute the same secret with ECDH and derive one key per
 *      direction with HKDF-SHA256, bound to both node ids and both public keys
 *   4. each request and each response is sealed with AES-256-GCM under the key
 *      for its direction (see envelope.ts for framing, replay protection and
 *      the binding of a response to its request)
 *
 * What this does not do: hide that two nodes are talking, authenticate the very
 * first contact, or provide forward secrecy (the keys are static per pair). The
 * first contact is what pinning is for -- the key a peer presents when it is
 * approved is remembered, and a different key later is refused until the user
 * resets it, exactly like `known_hosts`. The fingerprint lets two users compare
 * keys out of band before approving.
 *
 * Everything here is in Node's crypto, so it behaves the same on macOS, Linux
 * and Windows; the CI matrix runs these tests on all three.
 */

import * as crypto from "node:crypto";

export interface KeyPair {
  /** base64 of the DER-encoded SPKI public key. */
  publicKey: string;
  /** base64 of the DER-encoded PKCS#8 private key. */
  privateKey: string;
}

export interface DirectionKeys {
  /** Key for what this node sends. */
  out: Buffer;
  /** Key for what this node receives. */
  in: Buffer;
}

export interface Sealed {
  /** Nonce, base64. */
  n: string;
  /** Ciphertext including the GCM tag, base64. */
  c: string;
}

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
/** First byte of a binary sealed frame, so a future format can be told apart. */
const FRAME_VERSION = 0x02;
/** Bytes a binary frame adds to its plaintext: version, nonce and tag. */
export const SEAL_OVERHEAD = 1 + NONCE_LENGTH + TAG_LENGTH;
/** A base64 SPKI X25519 key is 60 characters; anything much longer is not one. */
const MAX_PUBLIC_KEY_LENGTH = 128;

export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function isKeyMaterial(value: unknown): value is KeyPair {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as KeyPair).publicKey === "string" &&
    typeof (value as KeyPair).privateKey === "string" &&
    (value as KeyPair).publicKey.length > 0 &&
    (value as KeyPair).privateKey.length > 0
  );
}

function importPublic(publicKey: string): crypto.KeyObject {
  if (publicKey.length > MAX_PUBLIC_KEY_LENGTH) throw new Error("the public key is too long");
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    type: "spki",
    format: "der",
  });
  if (key.asymmetricKeyType !== "x25519") throw new Error("the public key is not an X25519 key");
  return key;
}

function importPrivate(privateKey: string): crypto.KeyObject {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (key.asymmetricKeyType !== "x25519") throw new Error("the private key is not an X25519 key");
  return key;
}

/** Is this a public key this node can derive keys with? Never throws. */
export function isValidPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    importPublic(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the stored keypair actually work, and do its halves belong together?
 * A truncated or hand-edited identity file must not surface as a crash on the
 * first request.
 */
export function isUsableKeyPair(value: unknown): value is KeyPair {
  if (!isKeyMaterial(value)) return false;
  try {
    const privateKey = importPrivate(value.privateKey);
    const derived = crypto
      .createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64");
    return derived === value.publicKey;
  } catch {
    return false;
  }
}

/**
 * Derive the two directional keys for a pair of nodes.
 *
 * Both node ids and both public keys go into the derivation, ordered by node
 * id, so the two sides compute the same value while a key cannot be re-used
 * under another identity (no unknown-key-share). A label per direction keeps
 * one key from being usable backwards.
 */
export function deriveKeys(
  mine: KeyPair,
  theirPublicKey: string,
  myNodeId: string,
  theirNodeId: string,
): DirectionKeys {
  if (myNodeId === theirNodeId) throw new Error("a node cannot derive keys with itself");
  const secret = crypto.diffieHellman({
    privateKey: importPrivate(mine.privateKey),
    publicKey: importPublic(theirPublicKey),
  });
  // A low-order public key forces an all-zero secret; refuse it rather than
  // derive keys an attacker can predict.
  if (secret.every((byte) => byte === 0)) throw new Error("the public key yields no shared secret");

  const iAmFirst = myNodeId < theirNodeId;
  const first = iAmFirst
    ? { id: myNodeId, pub: mine.publicKey }
    : { id: theirNodeId, pub: theirPublicKey };
  const second = iAmFirst
    ? { id: theirNodeId, pub: theirPublicKey }
    : { id: myNodeId, pub: mine.publicKey };
  const salt = Buffer.from(`pi-swarm/2|${first.id}|${second.id}`, "utf-8");
  const info = Buffer.from(`pi-swarm/2 transport keys|${first.pub}|${second.pub}`, "utf-8");
  const base = Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, KEY_LENGTH * 2));

  const forward = base.subarray(0, KEY_LENGTH);
  const backward = base.subarray(KEY_LENGTH, KEY_LENGTH * 2);
  // The node with the smaller id uses "forward" for its own outgoing direction,
  // so both sides agree without exchanging anything else.
  return iAmFirst ? { out: forward, in: backward } : { out: backward, in: forward };
}

/** A short, human-checkable form of a public key, for a first-contact compare. */
export function fingerprint(publicKey: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  return digest.slice(0, 32).replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * Seal into a compact binary frame: version, nonce, ciphertext, tag.
 * This is what goes over the wire; it adds SEAL_OVERHEAD bytes and nothing else.
 */
export function sealFrame(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  return Buffer.concat([
    Buffer.from([FRAME_VERSION]),
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export function openFrame(key: Buffer, frame: Buffer, aad: string): Buffer {
  if (frame.length < SEAL_OVERHEAD || frame[0] !== FRAME_VERSION) {
    throw new Error("sealed payload is malformed");
  }
  const nonce = frame.subarray(1, 1 + NONCE_LENGTH);
  const tag = frame.subarray(frame.length - TAG_LENGTH);
  const ciphertext = frame.subarray(1 + NONCE_LENGTH, frame.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** JSON form of a sealed payload ({n, c}); kept for callers that embed it in JSON. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const frame = sealFrame(key, plaintext, aad);
  return {
    n: frame.subarray(1, 1 + NONCE_LENGTH).toString("base64"),
    c: frame.subarray(1 + NONCE_LENGTH).toString("base64"),
  };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const nonce = Buffer.from(sealed.n, "base64");
  const raw = Buffer.from(sealed.c, "base64");
  if (nonce.length !== NONCE_LENGTH || raw.length < TAG_LENGTH) throw new Error("sealed payload is malformed");
  return openFrame(key, Buffer.concat([Buffer.from([FRAME_VERSION]), nonce, raw]), aad);
}

/** Is this value shaped like something `seal` produced? */
export function isSealed(value: unknown): value is Sealed {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Sealed).n === "string" &&
    typeof (value as Sealed).c === "string"
  );
}
