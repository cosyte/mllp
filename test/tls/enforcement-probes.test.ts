/**
 * The enforcement probes behind `resolveTlsCipherPolicy`, against TLS libraries that do not
 * enforce what they are given.
 *
 * Before a cipher list or Diffie-Hellman parameters are handed to the runtime, the policy proves
 * with probes that the runtime enforces that kind of input at all. Node.js passes every probe, so
 * the refusals are reached here by standing a modelled TLS library behind `createSecureContext`:
 *
 * - `lenient` accepts every input and applies none of it, the way Deno's `node:tls` takes a
 *   `ciphers` list and a `dhparam` and then negotiates without them;
 * - `no-ffdhe` has no finite-field Diffie-Hellman at all, the way Bun's TLS library refuses the
 *   automatic `dhparam` selection and every DHE suite, and otherwise enforces a list;
 * - `throws-non-error` throws a value that is not an `Error`.
 *
 * `test/tls/runtime-enforcement.test.ts` runs the same configurations against the real runtime
 * under Node.js, Bun and Deno.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Tls from "node:tls";
import type { SecureContextOptions } from "node:tls";

/** Which TLS library stands behind `createSecureContext` for the case running. */
type Model = "real" | "lenient" | "no-ffdhe" | "throws-non-error";

const model: { mode: Model } = vi.hoisted(() => ({ mode: "real" }));

vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof Tls>();
  const createSecureContext = (options: SecureContextOptions): unknown => {
    switch (model.mode) {
      case "lenient":
        return {};
      case "no-ffdhe":
        if (options.dhparam === "auto") {
          throw new Error("Automatic DH parameter selection is not supported");
        }
        // A list of DHE suites selects nothing here, and so does a list that removes what it
        // names; everything else is taken. Modelled rather than delegated, so the model behaves
        // the same under whichever runtime runs the suite.
        if (
          typeof options.ciphers === "string" &&
          (options.ciphers.startsWith("DHE-") || options.ciphers.includes("!"))
        ) {
          throw new Error("no cipher match");
        }
        return {};
      case "throws-non-error":
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw "not an Error";
      case "real":
        return actual.createSecureContext(options);
    }
  };
  return { ...actual, createSecureContext, default: { ...actual, createSecureContext } };
});

import {
  ATNA_CIPHER_LIST,
  MLLP_TLS_CIPHER_OPTION_CONFLICT,
  MLLP_TLS_DH_PARAMETERS_REJECTED,
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
  MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
  resolveTlsCipherPolicy,
  tlsConfigurationMessage,
  type TlsCipherPolicyInput,
} from "../../src/index.js";
import { DH_PARAMETERS_3072_PEM } from "../helpers/dhparam-fixtures.js";
import { RUNTIME } from "../_helpers/runtime.js";

afterEach(() => {
  model.mode = "real";
});

/** The configuration error `resolveTlsCipherPolicy` throws, failing if it returns. */
function refusal(
  input: TlsCipherPolicyInput,
  side: "client" | "server",
): MllpTlsConfigurationError {
  try {
    resolveTlsCipherPolicy(input, side);
  } catch (err) {
    expect(err).toBeInstanceOf(MllpTlsConfigurationError);
    return err as MllpTlsConfigurationError;
  }
  throw new Error("expected a configuration error");
}

const ECDHE_ONLY = "ECDHE-RSA-AES128-GCM-SHA256";

describe("a TLS library that takes a list or parameters and applies none of it", () => {
  it("refuses a ciphers list, on either side, with no cause", () => {
    model.mode = "lenient";
    for (const side of ["client", "server"] as const) {
      const err = refusal({ ciphers: ECDHE_ONLY }, side);
      expect(err.code).toBe(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
      expect(err.cause).toBeUndefined();
      expect(err.message).toBe(tlsConfigurationMessage(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE));
    }
  });

  it("refuses the ATNA option on a client", () => {
    model.mode = "lenient";
    const err = refusal({ atnaTransportSecurity: true }, "client");
    expect(err.code).toBe(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
    expect(err.cause).toBeUndefined();
  });

  it("refuses the ATNA option on a server, on its Diffie-Hellman half", () => {
    model.mode = "lenient";
    const err = refusal({ atnaTransportSecurity: true }, "server");
    expect(err.code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(err.cause).toBeUndefined();
    expect(err.message).toBe(tlsConfigurationMessage(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE));
  });

  it("refuses a server's own group, which it would have run without", () => {
    model.mode = "lenient";
    const err = refusal({ dhParameters: DH_PARAMETERS_3072_PEM }, "server");
    expect(err.code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(err.cause).toBeUndefined();
  });

  it("refuses nothing that asks for nothing", () => {
    model.mode = "lenient";
    expect(resolveTlsCipherPolicy({}, "client")).toEqual({});
    expect(resolveTlsCipherPolicy({}, "server")).toEqual({});
    // A group on the client side is ignored, so nothing about it is probed either.
    expect(resolveTlsCipherPolicy({ dhParameters: DH_PARAMETERS_3072_PEM }, "client")).toEqual({});
  });
});

describe("a TLS library with no finite-field Diffie-Hellman", () => {
  it("still takes a list of suites it has", () => {
    model.mode = "no-ffdhe";
    expect(resolveTlsCipherPolicy({ ciphers: ECDHE_ONLY }, "client")).toEqual({
      ciphers: ECDHE_ONLY,
    });
    expect(resolveTlsCipherPolicy({ ciphers: ECDHE_ONLY }, "server")).toEqual({
      ciphers: ECDHE_ONLY,
    });
  });

  it("still refuses a list it reads and rejects, as a rejection rather than as unenforceable", () => {
    model.mode = "no-ffdhe";
    const err = refusal({ ciphers: "DHE-RSA-AES128-GCM-SHA256" }, "client");
    expect(err.code).toBe(MLLP_TLS_CIPHER_LIST_REJECTED);
  });

  it("refuses the ATNA option on a client, with the library's refusal of a named suite as the cause", () => {
    model.mode = "no-ffdhe";
    const err = refusal({ atnaTransportSecurity: true }, "client");
    expect(err.code).toBe(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause?.message).toBe("no cipher match");
  });

  it("refuses the ATNA option on a server, wrapping the library's own refusal", () => {
    model.mode = "no-ffdhe";
    const err = refusal({ atnaTransportSecurity: true }, "server");
    expect(err.code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause?.message).toBe("Automatic DH parameter selection is not supported");
  });

  it("refuses a server's own group, wrapping the library's own refusal", () => {
    model.mode = "no-ffdhe";
    const err = refusal({ dhParameters: DH_PARAMETERS_3072_PEM }, "server");
    expect(err.code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(err.cause?.message).toBe("Automatic DH parameter selection is not supported");
  });
});

describe("a TLS library that throws something other than an Error", () => {
  it("is still reported with an Error as the cause", () => {
    model.mode = "throws-non-error";
    const unenforceable = refusal({ atnaTransportSecurity: true }, "client");
    expect(unenforceable.code).toBe(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
    expect(unenforceable.cause).toBeInstanceOf(Error);
    expect(unenforceable.cause?.message).toBe("not an Error");

    const dh = refusal({ atnaTransportSecurity: true }, "server");
    expect(dh.code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(dh.cause).toBeInstanceOf(Error);
    expect(dh.cause?.message).toBe("not an Error");
  });
});

describe("the runtime as it is, under the same mock", () => {
  // Every probe passes on Node.js; this pins that the model above is what refuses, not the mock.
  // Node only: Bun and Deno each fail a probe for real, which runtime-enforcement.test.ts pins.
  it.skipIf(RUNTIME !== "node")("Node.js passes every probe, on both sides", () => {
    expect(resolveTlsCipherPolicy({ ciphers: ECDHE_ONLY }, "client")).toEqual({
      ciphers: ECDHE_ONLY,
    });
    expect(resolveTlsCipherPolicy({ atnaTransportSecurity: true }, "client")).toEqual({
      ciphers: ATNA_CIPHER_LIST,
    });
    expect(resolveTlsCipherPolicy({ atnaTransportSecurity: true }, "server")).toEqual({
      ciphers: ATNA_CIPHER_LIST,
      dhparam: "auto",
    });
    expect(resolveTlsCipherPolicy({ dhParameters: DH_PARAMETERS_3072_PEM }, "server")).toEqual({
      dhparam: DH_PARAMETERS_3072_PEM,
    });
  });
});

describe("the two new codes and every configuration message", () => {
  it("are the stable values a caller branches and logs on", () => {
    expect(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE).toBe("MLLP_TLS_CIPHER_LIST_UNENFORCEABLE");
    expect(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE).toBe("MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE");
    expect(tlsConfigurationMessage(MLLP_TLS_CIPHER_LIST_REJECTED)).toBe(
      "the TLS library rejected the configured cipher-suite list; no connection was opened and " +
        "no fallback to the runtime default list was made",
    );
    expect(tlsConfigurationMessage(MLLP_TLS_CIPHER_OPTION_CONFLICT)).toBe(
      "tls.atnaTransportSecurity and tls.ciphers both declare the offered cipher-suite list; " +
        "set exactly one of them",
    );
    expect(tlsConfigurationMessage(MLLP_TLS_DH_PARAMETERS_REJECTED)).toBe(
      "the configured ephemeral Diffie-Hellman parameters are not usable; nothing was bound and " +
        "no fallback to a server without Diffie-Hellman parameters was made",
    );
    expect(tlsConfigurationMessage(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE)).toBe(
      "this runtime's TLS library does not enforce a configured cipher-suite list; no " +
        "connection was opened, rather than one offering a list other than the one configured",
    );
    expect(tlsConfigurationMessage(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE)).toBe(
      "this runtime's TLS library does not enforce server Diffie-Hellman parameters; nothing " +
        "was bound, rather than a server running without the parameters configured",
    );
  });
});
