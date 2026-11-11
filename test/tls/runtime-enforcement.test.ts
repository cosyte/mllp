/**
 * The cipher and Diffie-Hellman options fail loudly on a runtime that would not enforce them.
 *
 * This file runs against the real `node:tls` of whichever runtime runs the suite, and CI runs it
 * under Node.js, Bun and Deno. Each case states what each runtime does:
 *
 * - **Node.js** enforces both kinds of input, so every configuration here is accepted.
 * - **Deno** takes a `ciphers` list and a `dhparam` without applying either (a peer restricted to a
 *   DHE suite negotiated an ECDHE one), so both are refused as unenforceable before any socket.
 * - **Bun** enforces a list but has no finite-field Diffie-Hellman: it refuses the automatic
 *   `dhparam` selection outright and has no DHE suite, so the ATNA option and `dhParameters` are
 *   refused as unenforceable, its own refusal carried as the `cause`, while a list of suites it has
 *   is accepted.
 *
 * `test/tls/enforcement-probes.test.ts` reaches every branch on Node.js with modelled libraries.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import {
  ATNA_CIPHER_LIST,
  isTransientConnectionError,
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
  MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
  resolveTlsCipherPolicy,
  type TlsCipherPolicyInput,
  type TlsConfigurationErrorCode,
} from "../../src/index.js";
import { DH_PARAMETERS_3072_PEM } from "../helpers/dhparam-fixtures.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";
import { RUNTIME } from "../_helpers/runtime.js";

const ECDHE_ONLY = "ECDHE-RSA-AES128-GCM-SHA256";

/** What one runtime does with one configuration: accepted, or refused with this code. */
type Outcome = "accepted" | TlsConfigurationErrorCode;

interface Case {
  readonly label: string;
  readonly input: TlsCipherPolicyInput;
  readonly side: "client" | "server";
  readonly expected: Readonly<Record<typeof RUNTIME, Outcome>>;
  /** The runtime's own refusal is carried as the cause on these runtimes. */
  readonly causeOn?: ReadonlyArray<typeof RUNTIME>;
}

const CASES: readonly Case[] = [
  {
    label: "a ciphers list of suites every runtime has, on a client",
    input: { ciphers: ECDHE_ONLY },
    side: "client",
    expected: { node: "accepted", bun: "accepted", deno: MLLP_TLS_CIPHER_LIST_UNENFORCEABLE },
  },
  {
    label: "a ciphers list of suites every runtime has, on a server",
    input: { ciphers: ECDHE_ONLY },
    side: "server",
    expected: { node: "accepted", bun: "accepted", deno: MLLP_TLS_CIPHER_LIST_UNENFORCEABLE },
  },
  {
    label: "the ATNA option on a client",
    input: { atnaTransportSecurity: true },
    side: "client",
    expected: {
      node: "accepted",
      bun: MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
      deno: MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
    },
    causeOn: ["bun"],
  },
  {
    label: "the ATNA option on a server",
    input: { atnaTransportSecurity: true },
    side: "server",
    expected: {
      node: "accepted",
      bun: MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
      deno: MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
    },
    causeOn: ["bun"],
  },
  {
    label: "a server's own Diffie-Hellman group",
    input: { dhParameters: DH_PARAMETERS_3072_PEM },
    side: "server",
    expected: {
      node: "accepted",
      bun: MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
      deno: MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
    },
    causeOn: ["bun"],
  },
];

describe(`the cipher and Diffie-Hellman options on this runtime (${RUNTIME})`, () => {
  it.each(CASES)("$label", ({ input, side, expected, causeOn }) => {
    const want = expected[RUNTIME];
    if (want === "accepted") {
      expect(() => resolveTlsCipherPolicy(input, side)).not.toThrow();
      return;
    }
    let thrown: unknown = null;
    try {
      resolveTlsCipherPolicy(input, side);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MllpTlsConfigurationError);
    const err = thrown as MllpTlsConfigurationError;
    expect(err.code).toBe(want);
    if (causeOn?.includes(RUNTIME) === true) {
      expect(err.cause).toBeInstanceOf(Error);
    } else {
      expect(err.cause).toBeUndefined();
    }
    // A configuration error is never retried: every attempt would meet the same runtime.
    expect(isTransientConnectionError(err)).toBe(false);
  });

  // Node only: the other two refuse this configuration, as the table above pins.
  it.skipIf(RUNTIME !== "node")("Node.js offers the ATNA list as configured", () => {
    expect(resolveTlsCipherPolicy({ atnaTransportSecurity: true }, "client")).toEqual({
      ciphers: ATNA_CIPHER_LIST,
    });
  });
});

describe(`a server and a client with the options on this runtime (${RUNTIME})`, () => {
  const servers: MllpServer[] = [];
  const clients: MllpClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    for (const s of servers) await s.close().catch(() => undefined);
    servers.length = 0;
  });

  it("a server with the ATNA option is constructed, and listen() says whether it can serve", async () => {
    const { cert, key } = buildServerCertFixture();
    // Construction never throws: under Bun this was a plain Error from inside the TLS library.
    const server = createServer({ tls: { cert, key, atnaTransportSecurity: true } });
    servers.push(server);

    const outcome = await server.listen(0, "127.0.0.1").then(
      () => "listening",
      (err: unknown) => err,
    );
    if (RUNTIME === "node") {
      expect(outcome).toBe("listening");
      return;
    }
    expect(outcome).toBeInstanceOf(MllpTlsConfigurationError);
    expect((outcome as MllpTlsConfigurationError).code).toBe(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
    expect(server.getStats().listening).toBe(false);
    expect(server.getStats().port).toBeNull();
  });

  it("a client with a ciphers list connects only where the list is enforced", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key }, autoAck: "AA" });
    servers.push(server);
    await server.listen(0, "127.0.0.1");
    const port = server.getStats().port;
    if (port === null) throw new Error("expected a bound port");
    let accepted = 0;
    server.on("connection", () => {
      accepted += 1;
    });

    const client = createClient({
      host: "127.0.0.1",
      port,
      tls: { ca: cert, servername: "localhost", ciphers: ECDHE_ONLY, maxVersion: "TLSv1.2" },
    });
    clients.push(client);
    const outcome = await client.connect().then(
      () => "connected",
      (err: unknown) => err,
    );
    if (RUNTIME === "deno") {
      expect(outcome).toBeInstanceOf(MllpTlsConfigurationError);
      expect((outcome as MllpTlsConfigurationError).code).toBe(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
      expect(accepted).toBe(0);
      return;
    }
    expect(outcome).toBe("connected");
  });
});
