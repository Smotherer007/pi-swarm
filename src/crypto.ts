/**
 * Application-level encryption for the swarm transport.
 *
 * Plain HTTP over a LAN means a sniffer reads every message, every knowledge
 * entry and every file -- and the bearer token in the header, which is enough
 * to impersonate a peer. TLS would fix the wire but needs certificates, and
 * `node:crypto` cannot sign one. So the payload is sealed instead, with keys
 * the two nodes derive themselves:
 *
 *   1. every node has a long-term X25519 keypair, created with its identity
 *   2. the public half travels with the beacon and with every handshake
 *   3. both sides compute the same secret with ECDH and derive one key per
 *      direction with HKDF-SHA256
 *   4. each request and each response is sealed with AES-256-GCM under the key
 *      for that direction, so reading it requires the key, not the token
 *
 * What this does not do: hide that two nodes are talking, or authenticate the
 * very first contact. That is what pinning is for -- the key a peer presents
 * when it is approved is remembered, and a different key later is refused until
 * the user resets it, exactly like `known_hosts`.
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
  return crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    type: "spki",
    format: "der",
  });
}

function importPrivate(privateKey: string): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    type: "pkcs8",
    format: "der",
  });
}

/**
 * Derive the two directional keys for a pair of nodes.
 *
 * The salt binds the result to both node ids in sorted order, so the two sides
 * compute the same value while a third node that shares no secret cannot, and a
 * label per direction keeps one key from being usable backwards.
 */
export function deriveKeys(
  mine: KeyPair,
  theirPublicKey: string,
  myNodeId: string,
  theirNodeId: string,
): DirectionKeys {
  const secret = crypto.diffieHellman({
    privateKey: importPrivate(mine.privateKey),
    publicKey: importPublic(theirPublicKey),
  });

  const pair = [myNodeId, theirNodeId].sort();
  const salt = Buffer.from(`pi-swarm/v1|${pair[0]}|${pair[1]}`, "utf-8");
  const base = Buffer.from(crypto.hkdfSync("sha256", secret, salt, "pi-swarm keys", KEY_LENGTH * 2));

  const forward = base.subarray(0, KEY_LENGTH);
  const backward = base.subarray(KEY_LENGTH, KEY_LENGTH * 2);
  // The node with the smaller id uses "forward" for its own outgoing direction,
  // so both sides agree without exchanging anything else.
  const iAmFirst = myNodeId === pair[0];
  return iAmFirst ? { out: forward, in: backward } : { out: backward, in: forward };
}

/** A short, human-checkable form of a public key, for a first-contact compare. */
export function fingerprint(publicKey: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  return digest.slice(0, 32).replace(/(.{4})(?=.)/g, "$1 ");
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { n: nonce.toString("base64"), c: ciphertext.toString("base64") };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const nonce = Buffer.from(sealed.n, "base64");
  const raw = Buffer.from(sealed.c, "base64");
  if (nonce.length !== 12 || raw.length < 16) throw new Error("sealed payload is malformed");
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
