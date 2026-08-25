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
