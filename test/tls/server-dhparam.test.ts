/**
 * Caller-supplied ephemeral Diffie-Hellman parameters on the server, over real
 * sockets and real TLS.
 *
 * WHAT THE PASSTHROUGH BUYS, AND WHY THAT IS GRADED BY A HANDSHAKE. A DHE
 * cipher suite is unofferable by a server with no parameters: it advertises the
 * suite and then fails every handshake in it. So every claim here is graded
 * against an observed negotiation with a peer restricted to one suite, and the
 * pair of cases that matters is the SAME server configuration with and without
 * the parameters. Reading a configured field back would prove nothing, because
 * the TLS library discards parameters it cannot read in complete silence.
 *
 * The group in force on a completed link is read from the TLS socket's own
 * ephemeral key information, which the runtime reports on the client end of a
 * connection. That is a property of the link rather than of this package's
 * internals, which is what makes the precedence case gradeable at all.
 *
 * FIXTURES ARE FIXED AND COMMITTED (`test/helpers/dhparam-fixtures.ts`).
 * Generating a group takes minutes and makes a suite flaky; the committed
 * groups are published MODP groups whose provenance the first case pins against
 * Node's own copy. They carry no secret material.
 *
 * TLS handshakes need REAL timers; this suite never enables fake timers.
 */
import { getDiffieHellman } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { createClient } from "../../src/client/client.js";
import type { MllpClient } from "../../src/client/client.js";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import {
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_DH_PARAMETERS_REJECTED,
  tlsConfigurationMessage,
} from "../../src/transport/error.js";
import {
  DH_PARAMETERS_3072_BITS,
  DH_PARAMETERS_3072_GROUP,
  DH_PARAMETERS_3072_PEM,
  DH_PARAMETERS_768_GROUP,
  DH_PARAMETERS_768_PEM,
  readDhPrime,
} from "../helpers/dhparam-fixtures.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

/** The one DHE suite every case here restricts a peer to, in both spellings. */
const DHE_SUITE_OPENSSL = "DHE-RSA-AES128-GCM-SHA256";
const DHE_SUITE_IANA = "TLS_DHE_RSA_WITH_AES_128_GCM_SHA256";

/** Its ECDHE sibling, for the case where the peer does not take the DHE road. */
const ECDHE_SUITE_OPENSSL = "ECDHE-RSA-AES128-GCM-SHA256";
const ECDHE_SUITE_IANA = "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256";

/**
 * The group size the runtime selects on its own for the certificates this
 * suite builds (2048-bit RSA). It is asserted rather than assumed, in the
 * precedence case, whose whole point is that the caller's group is a DIFFERENT
 * size from this one.
 */
const AUTOMATIC_GROUP_BITS = 2048;

/**
 * A synthetic HL7 frame. Single-letter application and facility names and no
 * `PID` segment at all: this file sits under a PHI-scan walk root and carries
 * no patient data, real or realistic.
 */
const SYNTHETIC_FRAME = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|D1|P|2.5\r");

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

/** Poll `cond` every 10ms until true or `timeoutMs` elapses (real timers). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The negotiated ephemeral key of a completed link, read off the client socket. */
interface EphemeralKey {
  readonly type: string;
  readonly size: number;
}

function readEphemeralKey(socket: TLSSocket): EphemeralKey {
  const info: unknown = socket.getEphemeralKeyInfo();
  if (typeof info !== "object" || info === null) {
    throw new Error("the socket reported no ephemeral key information");
  }
  if (!("type" in info) || !("size" in info)) {
    throw new Error("the socket reported a non-ephemeral key exchange");
  }
  const { type, size } = info;
  if (typeof type !== "string" || typeof size !== "number") {
    throw new Error("the socket reported ephemeral key information of an unexpected shape");
  }
  return { type, size };
}

/** What one raw TLS 1.2 handshake against `port`, restricted to `ciphers`, agreed on. */
interface Handshake {
  readonly suite: string;
  readonly ephemeral: EphemeralKey;
}

async function handshake(port: number, ca: string, ciphers: string): Promise<Handshake> {
  return new Promise<Handshake>((resolve, reject) => {
    const raw = tlsConnect(
      {
        host: "127.0.0.1",
        port,
        ca,
        servername: "localhost",
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ciphers,
      },
      () => {
        const observed: Handshake = {
          suite: raw.getCipher().standardName,
          ephemeral: readEphemeralKey(raw),
        };
        raw.end();
        resolve(observed);
      },
    );
    raw.once("error", reject);
  });
}

/**
 * Every rendering of an error a caller or a log pipeline can reach: the message,
 * the default string form, the underlying cause, and the VALUES of its own
 * enumerable properties (the names alone would prove nothing about what they
 * carry).
 */
function renderError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message, String(err), err.stack ?? ""];
  for (const [key, value] of Object.entries(err)) {
    parts.push(key, String(value));
    if (value instanceof Error) parts.push(value.message, value.stack ?? "");
  }
  return parts.join("\n");
}

// Real handshakes plus 2048-bit RSA key generation per fixture: CPU-bound and
// machine-proportional, asserting outcomes rather than durations. Budgeted here
// rather than through the suite-wide ceiling, the same reasoning as
// test/tls/handshake-matrix.test.ts.
describe("server-supplied ephemeral Diffie-Hellman parameters", { timeout: 60_000 }, () => {
  const servers: MllpServer[] = [];
  const clients: MllpClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    for (const s of servers) await s.close().catch(() => undefined);
    servers.length = 0;
  });

  function trackServer(s: MllpServer): MllpServer {
    servers.push(s);
    return s;
  }
  function trackClient(c: MllpClient): MllpClient {
    clients.push(c);
    return c;
  }

  /** Collect every `'tlsNegotiated'` payload an emitter produces. */
  function collectNegotiated(emitter: MllpClient | MllpServer): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    emitter.on("tlsNegotiated", (p: Record<string, unknown>) => {
      seen.push(p);
    });
    return seen;
  }

  // Provenance -----------------------------------------------------------
  it("the committed groups are the published MODP groups they claim to be", () => {
    // Without this the suite could be exercising a group nobody chose, and a
    // transcription error in a 3072-bit constant is invisible by inspection.
    const supplied = must(readDhPrime(DH_PARAMETERS_3072_PEM));
    expect(supplied.equals(getDiffieHellman(DH_PARAMETERS_3072_GROUP).getPrime())).toBe(true);
    expect(supplied.length * 8).toBe(DH_PARAMETERS_3072_BITS);

    const weak = must(readDhPrime(DH_PARAMETERS_768_PEM));
    expect(weak.equals(getDiffieHellman(DH_PARAMETERS_768_GROUP).getPrime())).toBe(true);

    // The two halves of the precedence case have to differ, or it proves
    // nothing about which group is in force.
    expect(DH_PARAMETERS_3072_BITS).not.toBe(AUTOMATIC_GROUP_BITS);
  });

  // Criterion 1 ----------------------------------------------------------
  it(`a DHE-only server WITH parameters completes the handshake and reports ${DHE_SUITE_IANA}`, async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({
        tls: { cert, key, ciphers: DHE_SUITE_OPENSSL, dhParameters: DH_PARAMETERS_3072_PEM },
        autoAck: "AA",
      }),
    );
    const negotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, ciphers: DHE_SUITE_OPENSSL, maxVersion: "TLSv1.2" },
      }),
    );
    await client.connect();

    // The link carries a frame, so this is a working transport and not just a
    // completed handshake.
    const ack = await client.send(SYNTHETIC_FRAME);
    expect(ack.length).toBeGreaterThan(0);

    await waitFor(() => negotiated.length === 1);
    expect(negotiated[0]?.["cipherSuite"]).toBe(DHE_SUITE_IANA);
    expect(negotiated[0]?.["protocolVersion"]).toBe("TLSv1.2");
    expect(Object.isFrozen(negotiated[0])).toBe(true);

    await client.close();
  });

  // Criterion 2 ----------------------------------------------------------
  it("the SAME configuration with no parameters fails every handshake and carries no frame", async () => {
    // This is what the passthrough buys, stated as the case it removes: a
    // server restricted to a DHE suite advertises it and then answers nothing.
    const { cert, key } = buildServerCertFixture();
    const messages: unknown[] = [];
    const server = trackServer(
      createServer({
        tls: { cert, key, ciphers: DHE_SUITE_OPENSSL },
        autoAck: "AA",
      }),
    );
    server.on("message", (m: unknown) => messages.push(m));
    const negotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, ciphers: DHE_SUITE_OPENSSL, maxVersion: "TLSv1.2" },
      }),
    );
    await expect(client.connect()).rejects.toBeInstanceOf(Error);

    // Nothing negotiated, nothing delivered, and the send has nowhere to go.
    await expect(client.send(SYNTHETIC_FRAME)).rejects.toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 50));
    expect(negotiated).toHaveLength(0);
    expect(messages).toHaveLength(0);
    expect(server.getStats().tlsClientErrorsTotal).toBeGreaterThanOrEqual(1);
    // The listener itself is unharmed: it is the key exchange that failed.
    expect(server.getStats().listening).toBe(true);
  });

  // Criterion 3 ----------------------------------------------------------
  it("the caller's group takes precedence over the one the ATNA option selects", async () => {
    const { cert, key } = buildServerCertFixture();

    // The control: the ATNA option alone, so the runtime picks the group.
    const automatic = trackServer(
      createServer({ tls: { cert, key, atnaTransportSecurity: true } }),
    );
    await automatic.listen(0, "127.0.0.1");
    const automaticObserved = await handshake(
      must(automatic.getStats().port),
      cert,
      DHE_SUITE_OPENSSL,
    );
    expect(automaticObserved.suite).toBe(DHE_SUITE_IANA);
    expect(automaticObserved.ephemeral.type).toBe("DH");
    expect(automaticObserved.ephemeral.size).toBe(AUTOMATIC_GROUP_BITS);

    // The same option, plus the caller's own group. Both are set and the
    // configuration is accepted: this is deliberately not a conflict.
    const supplied = trackServer(
      createServer({
        tls: {
          cert,
          key,
          atnaTransportSecurity: true,
          dhParameters: DH_PARAMETERS_3072_PEM,
        },
      }),
    );
    const negotiated = collectNegotiated(supplied);
    await supplied.listen(0, "127.0.0.1");
    const suppliedObserved = await handshake(
      must(supplied.getStats().port),
      cert,
      DHE_SUITE_OPENSSL,
    );

    // Still an ATNA suite, so the option was not discarded to honour the group.
    expect(suppliedObserved.suite).toBe(DHE_SUITE_IANA);
    await waitFor(() => negotiated.length === 1);
    expect(negotiated[0]?.["cipherSuite"]).toBe(DHE_SUITE_IANA);

    // And the group in force is the caller's, which is a different size from
    // the one the automatic selection yields for this same certificate.
    expect(suppliedObserved.ephemeral.type).toBe("DH");
    expect(suppliedObserved.ephemeral.size).toBe(DH_PARAMETERS_3072_BITS);
    expect(suppliedObserved.ephemeral.size).not.toBe(automaticObserved.ephemeral.size);
  });

  // Criterion 4 ----------------------------------------------------------
  const UNUSABLE_PARAMETERS: ReadonlyArray<{ what: string; value: string }> = [
    { what: "content that is not PEM at all", value: "these are not parameters" },
    {
      what: "a PEM block of some other kind",
      // A certificate is the likeliest thing to arrive here by a copy/paste
      // slip, and the TLS library discards it in silence.
      value: buildServerCertFixture().cert,
    },
    {
      what: "a group the TLS library refuses",
      value: DH_PARAMETERS_768_PEM,
    },
    {
      what: "a DH PARAMETERS block whose body is not a two-INTEGER SEQUENCE",
      value: "-----BEGIN DH PARAMETERS-----\nZm9vYmFy\n-----END DH PARAMETERS-----\n",
    },
    {
      what: "the automatic selection asked for by name",
      // 'auto' is what the TLS library spells its own selection; on this field
      // it is not PEM content and is refused rather than quietly honoured.
      value: "auto",
    },
  ];

  for (const unusable of UNUSABLE_PARAMETERS) {
    it(`listen() is refused for ${unusable.what}, with nothing bound`, async () => {
      const { cert, key } = buildServerCertFixture();
      const server = trackServer(
        createServer({
          tls: { cert, key, ciphers: DHE_SUITE_OPENSSL, dhParameters: unusable.value },
        }),
      );
      const rejection = await server.listen(0, "127.0.0.1").then(
        () => null,
        (err: unknown) => err,
      );

      expect(rejection).toBeInstanceOf(MllpTlsConfigurationError);
      const typed = rejection as MllpTlsConfigurationError;
      expect(typed.code).toBe(MLLP_TLS_DH_PARAMETERS_REJECTED);
      // A stable code DISTINCT from the cipher-list rejection: the two have
      // different remedies and a caller branches on them separately.
      expect(typed.code).not.toBe(MLLP_TLS_CIPHER_LIST_REJECTED);
      expect(MLLP_TLS_DH_PARAMETERS_REJECTED).not.toBe(MLLP_TLS_CIPHER_LIST_REJECTED);

      // Nothing bound, and no fallback to a server running without parameters:
      // such a server would be listening on this port right now.
      expect(server.getStats().listening).toBe(false);
      expect(server.getStats().port).toBeNull();
      expect(server.getStats().host).toBeNull();
      // A refused server stays refused; it does not become listenable on retry.
      await expect(server.listen(0, "127.0.0.1")).rejects.toMatchObject({
        code: MLLP_TLS_DH_PARAMETERS_REJECTED,
      });
      expect(server.getStats().listening).toBe(false);
    });
  }

  it("the refusal is about the parameters, not about the configuration around them", async () => {
    // The control for the block above: the identical server with a usable group
    // binds and answers, so the refusals are specific rather than blanket.
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({
        tls: { cert, key, ciphers: DHE_SUITE_OPENSSL, dhParameters: DH_PARAMETERS_3072_PEM },
      }),
    );
    await server.listen(0, "127.0.0.1");
    expect(server.getStats().listening).toBe(true);
    const observed = await handshake(must(server.getStats().port), cert, DHE_SUITE_OPENSSL);
    expect(observed.suite).toBe(DHE_SUITE_IANA);
  });

  // Criterion 5 ----------------------------------------------------------
  it("a parameter refusal carries no credential material and no parameter bytes", async () => {
    const { cert, key } = buildServerCertFixture();
    const passphrase = "unit-test-passphrase-never-in-a-diagnostic";
    const server = trackServer(
      createServer({
        tls: { cert, key, passphrase, dhParameters: DH_PARAMETERS_768_PEM },
      }),
    );
    const rejection = await server.listen(0, "127.0.0.1").then(
      () => null,
      (err: unknown) => err,
    );
    const rendered = renderError(rejection);

    expect(rendered).not.toContain(passphrase);
    expect(rendered).not.toContain("PRIVATE KEY");
    expect(rendered).not.toContain(key.slice(40, 120));
    expect(rendered).not.toContain(cert.slice(40, 120));
    // The parameter bytes themselves: public values, but still the caller's
    // input, and an error is a log line.
    expect(rendered).not.toContain("DH PARAMETERS");
    expect(rendered).not.toContain(DH_PARAMETERS_768_PEM.slice(40, 120));

    // The message is a frozen registry entry, identical whatever the
    // configuration was: the factory takes only a code.
    expect((rejection as MllpTlsConfigurationError).message).toBe(
      tlsConfigurationMessage(MLLP_TLS_DH_PARAMETERS_REJECTED),
    );
  });

  it("a structural refusal reaches for no underlying cause at all", async () => {
    // Nothing outside this package refused it, so there is no library error to
    // attribute it to, and inventing one would put the input in reach.
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({ tls: { cert, key, dhParameters: "these are not parameters" } }),
    );
    const rejection = (await server.listen(0, "127.0.0.1").then(
      () => null,
      (err: unknown) => err,
    )) as MllpTlsConfigurationError;
    expect(rejection.cause).toBeUndefined();
  });

  // Criterion 6 ----------------------------------------------------------
  it("a peer that negotiates an ECDHE suite instead completes the handshake unchanged", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({
        tls: { cert, key, atnaTransportSecurity: true, dhParameters: DH_PARAMETERS_3072_PEM },
      }),
    );
    const negotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");

    const observed = await handshake(must(server.getStats().port), cert, ECDHE_SUITE_OPENSSL);
    expect(observed.suite).toBe(ECDHE_SUITE_IANA);
    // The supplied group is simply not part of an ECDHE key exchange.
    expect(observed.ephemeral.type).toBe("ECDH");

    await waitFor(() => negotiated.length === 1);
    expect(negotiated[0]?.["cipherSuite"]).toBe(ECDHE_SUITE_IANA);
  });
});
