/**
 * The cryptographic primitives the transport is built on.
 *
 * These run on macOS, Linux and Windows in CI, which is the point: X25519, HKDF
 * and AES-256-GCM all come from the OpenSSL that ships with Node, so a peer on
 * another platform derives the same keys without a certificate or a library.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as crypto from "node:crypto";

import {
  deriveKeys,
  fingerprint,
  isKeyMaterial,
  isSealed,
  isUsableKeyPair,
  isValidPublicKey,
  newKeyPair,
  open,
  openFrame,
  seal,
  SEAL_OVERHEAD,
  sealFrame,
} from "../src/crypto.ts";
import { responseAad } from "../src/envelope.ts";

const nodeA = "n_aaaa0000000000000000";
const nodeB = "n_bbbb1111111111111111";

describe("key agreement", () => {
  it("gives both sides the same pair of directional keys", () => {
    const a = newKeyPair();
    const b = newKeyPair();

    const fromA = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const fromB = deriveKeys(b, a.publicKey, nodeB, nodeA);

    assert.deepEqual(fromA.out, fromB.in, "what A sends, B reads");
    assert.deepEqual(fromA.in, fromB.out, "what B sends, A reads");
    assert.notDeepEqual(fromA.out, fromA.in, "the two directions are not the same key");
    assert.equal(fromA.out.length, 32);
  });

  it("does not depend on which node asks first", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const one = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const two = deriveKeys(a, b.publicKey, nodeA, nodeB);
    assert.deepEqual(one.out, two.out);
  });

  it("gives a third node nothing", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const c = newKeyPair();
    const ab = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const ac = deriveKeys(a, c.publicKey, nodeA, nodeB);
    assert.notDeepEqual(ab.out, ac.out);
  });

  it("produces keys a peer can compare by eye", () => {
    const a = newKeyPair();
    const print = fingerprint(a.publicKey);
    assert.match(print, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
    assert.equal(fingerprint(a.publicKey), print, "stable for the same key");
    assert.notEqual(fingerprint(newKeyPair().publicKey), print);
  });

  it("recognises key material", () => {
    assert.equal(isKeyMaterial(newKeyPair()), true);
    assert.equal(isKeyMaterial({ publicKey: "", privateKey: "x" }), false);
    assert.equal(isKeyMaterial(null), false);
  });
});

describe("sealing a payload", () => {
  it("round-trips with the shared key and nothing else", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const fromA = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const fromB = deriveKeys(b, a.publicKey, nodeB, nodeA);

    const plaintext = Buffer.from(JSON.stringify({ text: "hallo über das LAN" }), "utf-8");
    const sealedIt = seal(fromA.out, plaintext, "POST /swarm/v1/message");

    assert.equal(isSealed(sealedIt), true);
    assert.equal(JSON.stringify(sealedIt).includes("hallo"), false, "the plaintext is not in the envelope");

    const opened = open(fromB.in, sealedIt, "POST /swarm/v1/message");
    assert.equal(opened.toString("utf-8"), plaintext.toString("utf-8"));
  });

  it("fails when the payload is altered", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const keys = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const sealedIt = seal(keys.out, Buffer.from("original", "utf-8"), "GET /x");

    const raw = Buffer.from(sealedIt.c, "base64");
    raw[0] ^= 0xff;
    assert.throws(() => open(keys.in, { n: sealedIt.n, c: raw.toString("base64") }, "GET /x"));
  });

  it("fails when it travels to a different endpoint", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const keys = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const sealedIt = seal(keys.out, Buffer.from("payload", "utf-8"), "POST /swarm/v1/message");

    // The endpoint is part of the authenticated data, so a captured body cannot
    // be replayed against another route.
    assert.throws(() => open(keys.in, sealedIt, "POST /swarm/v1/leave"));
  });

  it("fails with the wrong direction", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const fromA = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const fromB = deriveKeys(b, a.publicKey, nodeB, nodeA);
    const sealedIt = seal(fromA.out, Buffer.from("payload", "utf-8"), "GET /x");
    // B's outgoing key is A's incoming key, so it must not open what A sent to B
    // on the other direction.
    assert.throws(
      () => open(fromB.out, sealedIt, "GET /x"),
      "the incoming key is not the outgoing one",
    );
  });

  it("rejects a malformed envelope instead of guessing", () => {
    const key = Buffer.alloc(32, 7);
    assert.throws(() => open(key, { n: "AA==", c: "AA==" }, "GET /x"), /malformed/);
    assert.equal(isSealed({ n: 1, c: "x" }), false);
  });
});

describe("hardening of the primitives", () => {
  it("binds the keys to both public keys, not only to the node ids", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const c = newKeyPair();
    // Same node ids, a different key on the other side: different transport keys.
    const ab = deriveKeys(a, b.publicKey, nodeA, nodeB);
    const ac = deriveKeys(a, c.publicKey, nodeA, nodeB);
    assert.notDeepEqual(ab.out, ac.out);
    // Same keys, different claimed node ids: different transport keys as well.
    const renamed = deriveKeys(a, b.publicKey, nodeA, "n_cccc2222222222222222");
    assert.notDeepEqual(ab.out, renamed.out);
  });

  it("refuses to derive keys with itself and with anything that is not X25519", () => {
    const a = newKeyPair();
    assert.throws(() => deriveKeys(a, a.publicKey, nodeA, nodeA), /itself/);
    const ed = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    assert.equal(isValidPublicKey(ed), false);
    assert.equal(isValidPublicKey("bm90IGEga2V5"), false);
    assert.equal(isValidPublicKey(a.publicKey), true);
    assert.throws(() => deriveKeys(a, ed, nodeA, nodeB));
  });

  it("notices a keypair whose halves do not belong together", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    assert.equal(isUsableKeyPair(a), true);
    assert.equal(isUsableKeyPair({ publicKey: b.publicKey, privateKey: a.privateKey }), false);
    assert.equal(isUsableKeyPair({ publicKey: "x", privateKey: "y" }), false);
  });

  it("frames binary payloads with a fixed overhead and authenticates them", () => {
    const key = crypto.randomBytes(32);
    const plaintext = crypto.randomBytes(1000);
    const frame = sealFrame(key, plaintext, "aad");
    assert.equal(frame.length, plaintext.length + SEAL_OVERHEAD);
    assert.deepEqual(openFrame(key, frame, "aad"), plaintext);
    assert.throws(() => openFrame(key, frame, "other aad"));
    const tampered = Buffer.from(frame);
    tampered[20] ^= 1;
    assert.throws(() => openFrame(key, tampered, "aad"));
    assert.throws(() => openFrame(key, frame.subarray(0, 10), "aad"), /malformed/);
  });

  it("binds a sealed answer to the request it answers", () => {
    const key = crypto.randomBytes(32);
    const frame = sealFrame(key, Buffer.from("{}"), responseAad(200, "POST", "/swarm/v1/message", "rid-one-0123456789"));
    assert.throws(() => openFrame(key, frame, responseAad(200, "POST", "/swarm/v1/message", "rid-two-0123456789")));
    assert.throws(() => openFrame(key, frame, responseAad(403, "POST", "/swarm/v1/message", "rid-one-0123456789")));
  });
});
