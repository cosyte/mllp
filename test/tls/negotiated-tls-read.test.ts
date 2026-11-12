/**
 * The refusals inside `readNegotiatedTlsParameters`, driven directly.
 *
 * The handshake matrix next door proves the happy paths over real sockets, and
 * proves that a plaintext link emits nothing. What it cannot reach is the set of
 * states a socket can be in where there is a TLS socket but nothing negotiated
 * to report yet: an in-flight handshake, and a session whose suite the library
 * declines to name. Each is a `return null`, which is what keeps a
 * half-populated record off the event, and each is unreachable from a completed
 * handshake by construction. So they are driven here against the smallest stub
 * that can be in that state, rather than left as unproven defensive code.
 *
 * No sockets are opened and no certificates are generated: this file is about
 * one pure read.
 */
import { describe, it, expect } from "vitest";
import { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import { readNegotiatedTlsParameters } from "../../src/transport/negotiated-tls.js";

/** The smallest object that can stand in for a TLS socket at this call site. */
function sessionStub(
  protocol: string | null,
  cipher: { name: string; standardName: string },
): TLSSocket {
  return {
    getProtocol: () => protocol,
    getCipher: () => ({ ...cipher, version: "TLSv1.2" }),
  } as unknown as TLSSocket;
}

describe("readNegotiatedTlsParameters refusals", () => {
  it("reports nothing for a socket that is not a TLS socket at all", () => {
    const plain = new Socket();
    expect(readNegotiatedTlsParameters(plain, "127.0.0.1", 2575)).toBeNull();
    plain.destroy();
  });

  it("reports nothing while there is no negotiated protocol yet", () => {
    const stub = sessionStub(null, { name: "AEAD-AES256-GCM-SHA384", standardName: "TLS_X" });
    expect(readNegotiatedTlsParameters(stub, "127.0.0.1", 2575)).toBeNull();
  });

  it("reports nothing when the library names the suite in neither spelling", () => {
    const stub = sessionStub("TLSv1.2", { name: "", standardName: "" });
    expect(readNegotiatedTlsParameters(stub, "127.0.0.1", 2575)).toBeNull();
  });

  it("falls back to the OpenSSL spelling when there is no IANA one", () => {
    const stub = sessionStub("TLSv1.2", {
      name: "ECDHE-RSA-AES128-GCM-SHA256",
      standardName: "",
    });
    const params = readNegotiatedTlsParameters(stub, "mllp.example.com", 2575);
    expect(params?.cipherSuite).toBe("ECDHE-RSA-AES128-GCM-SHA256");
    expect(params?.protocolVersion).toBe("TLSv1.2");
    expect(params?.host).toBe("mllp.example.com");
    expect(params?.port).toBe(2575);
    expect(Object.isFrozen(params)).toBe(true);
  });
});

/**
 * A socket that completed a TLS 1.3 handshake and answers `getEphemeralKeyInfo`
 * with `info`, or has no such method at all when `info` is the string `"absent"`.
 */
function groupStub(info: unknown): TLSSocket {
  const socket: Record<string, unknown> = {
    getProtocol: () => "TLSv1.3",
    getCipher: () => ({
      name: "TLS_AES_256_GCM_SHA384",
      standardName: "TLS_AES_256_GCM_SHA384",
      version: "TLSv1.3",
    }),
  };
  if (info !== "absent") socket["getEphemeralKeyInfo"] = () => info;
  return socket as unknown as TLSSocket;
}

describe("readNegotiatedTlsParameters key-exchange group", () => {
  it("reports an elliptic-curve group by its name", () => {
    const params = readNegotiatedTlsParameters(
      groupStub({ type: "ECDH", name: "X25519", size: 253 }),
      "127.0.0.1",
      2575,
    );
    expect(params?.keyExchangeGroup).toBe("X25519");
    expect(Object.isFrozen(params)).toBe(true);
  });

  it("reports a group with no classic key, such as a post-quantum hybrid", () => {
    const params = readNegotiatedTlsParameters(
      groupStub({ type: "TLSGroup", name: "X25519MLKEM768" }),
      "127.0.0.1",
      2575,
    );
    expect(params?.keyExchangeGroup).toBe("X25519MLKEM768");
  });

  // Each of these is a shape the runtime really answers with, or a runtime with no such method,
  // and none of them names a group: the key must then be missing, not present as undefined.
  const noGroup: ReadonlyArray<readonly [string, unknown]> = [
    ["a runtime with no getEphemeralKeyInfo", "absent"],
    ["a server socket, which Node answers with null", null],
    ["an empty answer", {}],
    ["a finite-field exchange, which has a size and no name", { type: "DH", size: 2048 }],
    ["an empty name", { type: "ECDH", name: "", size: 256 }],
    ["a name that is not a string", { type: "ECDH", name: 25519, size: 253 }],
    ["an answer that is not an object", "X25519"],
  ];
  for (const [label, info] of noGroup) {
    it(`omits the group for ${label}`, () => {
      const params = readNegotiatedTlsParameters(groupStub(info), "127.0.0.1", 2575);
      expect(params).not.toBeNull();
      expect(params?.cipherSuite).toBe("TLS_AES_256_GCM_SHA384");
      expect(Object.keys(params ?? {})).not.toContain("keyExchangeGroup");
    });
  }
});
