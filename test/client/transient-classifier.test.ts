/**
 * isTransientConnectionError classifier tests (PLAN-04, CLIENT-18).
 *
 * Verifies the transient/permanent classification. The classifier is invoked
 * BEFORE retryStrategy in Composition A (D-16) so its correctness gates
 * whether reconnect proceeds at all.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import {
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "../../src/client/error.js";
// Top-level barrel re-export check
import * as topBarrel from "../../src/index.js";

describe("isTransientConnectionError (CLIENT-18)", () => {
  it("Test 1: Error with no `code` returns true (default → transient)", () => {
    expect(isTransientConnectionError(new Error("boom"))).toBe(true);
  });

  it("Test 2: ECONNREFUSED → transient", () => {
    expect(isTransientConnectionError({ code: "ECONNREFUSED" })).toBe(true);
  });

  it("Test 3: ECONNRESET → transient", () => {
    expect(isTransientConnectionError({ code: "ECONNRESET" })).toBe(true);
  });

  it("Test 4: ETIMEDOUT → transient", () => {
    expect(isTransientConnectionError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("Test 5: EHOSTUNREACH → transient", () => {
    expect(isTransientConnectionError({ code: "EHOSTUNREACH" })).toBe(true);
  });

  it("Test 6: ENETUNREACH → transient", () => {
    expect(isTransientConnectionError({ code: "ENETUNREACH" })).toBe(true);
  });

  it("Test 7: EPIPE → transient", () => {
    expect(isTransientConnectionError({ code: "EPIPE" })).toBe(true);
  });

  it("Test 8: ENOTFOUND → permanent", () => {
    expect(isTransientConnectionError({ code: "ENOTFOUND" })).toBe(false);
  });

  it("Test 9: EACCES → permanent", () => {
    expect(isTransientConnectionError({ code: "EACCES" })).toBe(false);
  });

  it("Test 10: CERT_HAS_EXPIRED → permanent", () => {
    expect(isTransientConnectionError({ code: "CERT_HAS_EXPIRED" })).toBe(false);
  });

  it("Test 11: CERT_NOT_YET_VALID → permanent", () => {
    expect(isTransientConnectionError({ code: "CERT_NOT_YET_VALID" })).toBe(false);
  });

  it("Test 12: UNABLE_TO_VERIFY_LEAF_SIGNATURE → permanent", () => {
    expect(isTransientConnectionError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe(false);
  });

  it("Test 13: null and string → transient (non-Error → default)", () => {
    expect(isTransientConnectionError(null)).toBe(true);
    expect(isTransientConnectionError("string")).toBe(true);
    expect(isTransientConnectionError(undefined)).toBe(true);
    expect(isTransientConnectionError(42)).toBe(true);
  });

  it("Test 14: PLAN-01 sentinel `// PLAN-04 fills: isTransientConnectionError` is removed", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, "../../src/client/error.ts"), "utf8");
    expect(src).not.toMatch(/PLAN-04 fills: isTransientConnectionError/);
    // PLAN-05 sentinel removed once PLAN-05 fills MllpBackpressureError.
    expect(src).not.toMatch(/PLAN-05 fills: MllpBackpressureError/);
  });

  it("Test 15: re-exported from top-level barrel `src/index.ts`", () => {
    expect(
      typeof (topBarrel as { isTransientConnectionError?: unknown }).isTransientConnectionError,
    ).toBe("function");
  });

  // Extra defensive checks for additional CERT_* codes
  it("Test 16: DEPTH_ZERO_SELF_SIGNED_CERT → permanent", () => {
    expect(isTransientConnectionError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(false);
  });

  it("Test 17: SELF_SIGNED_CERT_IN_CHAIN → permanent", () => {
    expect(isTransientConnectionError({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(false);
  });

  it("Test 18: unknown error code → transient (Postel default)", () => {
    expect(isTransientConnectionError({ code: "EUNKNOWNFOO" })).toBe(true);
  });

  it("Test 19: non-string code → transient (default)", () => {
    expect(isTransientConnectionError({ code: 42 })).toBe(true);
  });

  describe("isTlsVerificationErrorCode (Phase 8)", () => {
    const verificationCodes = [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "CERT_REVOKED",
      "CERT_UNTRUSTED",
      "CERT_REJECTED",
      "CERT_SIGNATURE_FAILURE",
      "HOSTNAME_MISMATCH",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ] as const;

    it.each(verificationCodes)("%s is a verification error code", (code) => {
      expect(isTlsVerificationErrorCode(code)).toBe(true);
    });

    it("an unlisted CERT_* code is still treated as verification (prefix fallback)", () => {
      expect(isTlsVerificationErrorCode("CERT_SOME_FUTURE_CODE")).toBe(true);
    });

    it("a non-TLS code is NOT a verification error code", () => {
      expect(isTlsVerificationErrorCode("ECONNRESET")).toBe(false);
      expect(isTlsVerificationErrorCode("ERR_TLS_HANDSHAKE_TIMEOUT")).toBe(false);
    });

    it("re-exported from the top-level barrel src/index.ts", () => {
      expect(
        typeof (topBarrel as { isTlsVerificationErrorCode?: unknown }).isTlsVerificationErrorCode,
      ).toBe("function");
    });

    it("each verification code is classified permanent by isTransientConnectionError", () => {
      for (const code of verificationCodes) {
        expect(isTransientConnectionError({ code })).toBe(false);
      }
    });

    it("ERR_TLS_CERT_ALTNAME_INVALID (hostname/SAN mismatch) is classified permanent", () => {
      expect(isTransientConnectionError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(false);
    });
  });

  describe("isTlsProtocolError (Phase 8 — TLS-protocol-shaped boundary)", () => {
    it("ERR_SSL_* codes are TLS-protocol-shaped", () => {
      expect(isTlsProtocolError({ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" })).toBe(true);
      expect(isTlsProtocolError({ code: "ERR_SSL_WRONG_VERSION_NUMBER" })).toBe(true);
    });

    it("EPROTO is TLS-protocol-shaped (apply only on TLS connections)", () => {
      expect(isTlsProtocolError({ code: "EPROTO" })).toBe(true);
    });

    it("OpenSSL alert-bearing messages are TLS-protocol-shaped even without a code", () => {
      expect(
        isTlsProtocolError(
          new Error(
            "40CD333E:SSL routines:ssl3_read_bytes:tlsv13 alert certificate required:SSL alert number 116",
          ),
        ),
      ).toBe(true);
      expect(isTlsProtocolError(new Error("sslv3 alert handshake failure"))).toBe(true);
    });

    it("pure TCP failures are NOT TLS-protocol-shaped (stay transient)", () => {
      expect(isTlsProtocolError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })).toBe(
        false,
      );
      expect(isTlsProtocolError({ code: "ECONNRESET", message: "read ECONNRESET" })).toBe(false);
      expect(isTlsProtocolError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe(false);
      expect(isTlsProtocolError({ code: "EHOSTUNREACH", message: "connect EHOSTUNREACH" })).toBe(
        false,
      );
    });

    it("non-object / null inputs are not TLS-protocol-shaped", () => {
      expect(isTlsProtocolError(null)).toBe(false);
      expect(isTlsProtocolError(undefined)).toBe(false);
      expect(isTlsProtocolError("ssl alert")).toBe(false);
    });

    it("ERR_SSL_* is classified PERMANENT by isTransientConnectionError", () => {
      expect(
        isTransientConnectionError({ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" }),
      ).toBe(false);
    });

    it("re-exported from the top-level barrel src/index.ts", () => {
      expect(typeof (topBarrel as { isTlsProtocolError?: unknown }).isTlsProtocolError).toBe(
        "function",
      );
    });
  });
});
