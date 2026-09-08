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
  //
  // THE DAMAGED-ARMOUR CLASS, AND WHY IT IS HERE IN FORCE. A well-formed body
  // behind a damaged encapsulation boundary is the one class where "looks like a
  // PEM block" and "is a PEM block the TLS library reads" come apart, and it is
  // the class an operator reaches by accident rather than by typing garbage: a
  // value that crosses an environment variable, a single-line JSON field or any
  // whitespace-collapsing config layer arrives with its newlines gone and is
  // still a boundary, a body and a boundary in the right order. Every entry
  // below was measured on this container to leave a server that advertises its
  // DHE suite and then answers no handshake, which is precisely the fallback
  // this criterion forbids.
  const BEGIN = "-----BEGIN DH PARAMETERS-----";
  const END = "-----END DH PARAMETERS-----";
  const ARMOUR_LINES = DH_PARAMETERS_3072_PEM.trimEnd().split("\n");
  const BODY_LINES = ARMOUR_LINES.slice(1, -1);
  const BODY = BODY_LINES.join("");

  // A DER writer, local to this file, so the body cases below are built rather
  // than pasted as opaque base64 nobody can check by eye. It is deliberately
  // able to emit encodings a conforming writer would not (a redundant length
  // field, contents with no octets), because those are the inputs under test.
  function derLength(octets: number, width?: number): Buffer {
    if (width === undefined && octets < 0x80) return Buffer.from([octets]);
    const bytes: number[] = [];
    let rest = octets;
    while (rest > 0) {
      bytes.unshift(rest & 0xff);
      rest = Math.floor(rest / 256);
    }
    while (bytes.length < (width ?? 1)) bytes.unshift(0);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  function derElement(tag: number, content: Buffer, width?: number): Buffer {
    return Buffer.concat([Buffer.from([tag]), derLength(content.length, width), content]);
  }
  /** A DER `INTEGER` carrying `magnitude` as an unsigned big-endian value. */
  function derInteger(magnitude: Buffer): Buffer {
    const first = magnitude[0];
    const signed =
      first !== undefined && (first & 0x80) !== 0
        ? Buffer.concat([Buffer.from([0x00]), magnitude])
        : magnitude;
    return derElement(0x02, signed);
  }
  /** A DER `INTEGER` whose contents are used verbatim, sign rules and all. */
  function derRawInteger(content: Buffer): Buffer {
    return derElement(0x02, content);
  }
  /** Canonical armour around `der`: the exact form the library and reader want. */
  function armour(der: Buffer): string {
    const wrapped = der.toString("base64").match(/.{1,64}/g) ?? [];
    return BEGIN + "\n" + wrapped.join("\n") + "\n" + END + "\n";
  }
  /** A `DH PARAMETERS` block whose body is the given sequence contents. */
  function parametersFrom(...parts: Buffer[]): string {
    return armour(derElement(0x30, Buffer.concat(parts)));
  }

  const PRIME = must(readDhPrime(DH_PARAMETERS_3072_PEM));
  const PRIME_FIELD = derInteger(PRIME);
  const GENERATOR_FIELD = derInteger(Buffer.from([0x02]));
  /** The committed group, plus one element behind the two the template has. */
  function withExtra(extra: Buffer): string {
    return parametersFrom(PRIME_FIELD, GENERATOR_FIELD, extra);
  }

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
    {
      what: "armour with every newline stripped out of it",
      value: BEGIN + BODY + END,
    },
    {
      what: "an extra dash on the opening boundary",
      value: DH_PARAMETERS_3072_PEM.replace("-----BEGIN", "------BEGIN"),
    },
    {
      what: "an extra dash on the closing boundary",
      value: DH_PARAMETERS_3072_PEM.replace(END, END + "-"),
    },
    {
      what: "an opening boundary indented by a space",
      value: "  " + DH_PARAMETERS_3072_PEM,
    },
    {
      what: "a closing boundary indented by a tab",
      value: DH_PARAMETERS_3072_PEM.replace(END, "\t" + END),
    },
    {
      what: "anything else sharing the opening boundary's line",
      value: "site policy: " + DH_PARAMETERS_3072_PEM,
    },
    {
      what: "the body sharing a line with the opening boundary",
      value: BEGIN + BODY_LINES.join("\n") + "\n" + END + "\n",
    },
    {
      what: "the closing boundary sharing a line with the body",
      value: BEGIN + "\n" + BODY_LINES.join("\n") + END + "\n",
    },
    {
      what: "a blank line part way through the body",
      value:
        BEGIN +
        "\n" +
        BODY_LINES.slice(0, 3).join("\n") +
        "\n\n" +
        BODY_LINES.slice(3).join("\n") +
        "\n" +
        END +
        "\n",
    },
    {
      what: "carriage returns where the line feeds should be",
      value: DH_PARAMETERS_3072_PEM.replace(/\n/g, "\r"),
    },
    {
      what: "a label the PEM reader does not know",
      value: DH_PARAMETERS_3072_PEM.replace(/DH PARAMETERS/g, "DH  PARAMETERS"),
    },
  ];

  // THE OVERLONG-BODY CLASS, AND WHY IT NEEDS ITS OWN TABLE. Behind armour the
  // library reads, the body still has to be the whole parameter template and
  // nothing besides: `SEQUENCE { INTEGER prime, INTEGER base, INTEGER
  // privateValueLength OPTIONAL }`, with the optional field read at 32 bits.
  // Anything else is discarded exactly as silently as damaged armour is, and
  // every entry below was measured on this container to leave a server that
  // fails a DHE handshake in `tls_post_process_client_hello` with `no shared
  // cipher`, which is byte for byte what a server given no parameters at all
  // gives. The last case in particular is not hand-written DER for its own sake:
  // `SEQUENCE { p, g, q }` with a third field far too wide for a private-value
  // length is the shape an X9.42 or DSA parameter file has, which is the wrong
  // file under the right label rather than a typo.
  const UNUSABLE_BODIES: ReadonlyArray<{ what: string; value: string }> = [
    {
      what: "an OCTET STRING behind the generator",
      value: withExtra(derElement(0x04, Buffer.from("junkjunk"))),
    },
    { what: "a NULL behind the generator", value: withExtra(derElement(0x05, Buffer.alloc(0))) },
    {
      what: "a BOOLEAN behind the generator",
      value: withExtra(derElement(0x01, Buffer.from([0xff]))),
    },
    {
      what: "an empty SEQUENCE behind the generator",
      value: withExtra(derElement(0x30, Buffer.alloc(0))),
    },
    {
      what: "a third INTEGER far too wide to be a private-value length",
      value: withExtra(derInteger(Buffer.alloc(32, 0x41))),
    },
    {
      what: "a private-value length one octet past the width the library reads",
      value: withExtra(derInteger(Buffer.from([0x80, 0x00, 0x00, 0x00]))),
    },
    {
      what: "a redundantly padded private-value length",
      value: withExtra(derRawInteger(Buffer.from([0xff, 0xff, 0xff, 0xff]))),
    },
    {
      what: "a fourth element behind a private-value length the library would take",
      value: parametersFrom(
        PRIME_FIELD,
        GENERATOR_FIELD,
        derInteger(Buffer.from([0x01, 0x00])),
        derInteger(Buffer.from([0x01, 0x00])),
      ),
    },
    {
      what: "a context-specific tag where the private-value length goes",
      value: withExtra(derElement(0x82, Buffer.from([0x01]))),
    },
    {
      what: "a generator with no content octets at all",
      value: parametersFrom(PRIME_FIELD, derRawInteger(Buffer.alloc(0))),
    },
    {
      what: "a prime with no content octets at all",
      value: parametersFrom(derRawInteger(Buffer.alloc(0)), GENERATOR_FIELD),
    },
    { what: "a sequence carrying the prime and nothing else", value: parametersFrom(PRIME_FIELD) },
    { what: "an empty sequence", value: parametersFrom() },
  ];

  for (const unusable of [...UNUSABLE_PARAMETERS, ...UNUSABLE_BODIES]) {
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

  // Criterion 4, the other direction --------------------------------------
  //
  // THE STRICTNESS ABOVE IS BOUNDED, AND THE BOUND IS TESTED. A check that
  // refuses more than the runtime does is the same defect pointed the other way:
  // a configuration that would have worked, turned into a listener that will not
  // start. The TLS library reads PEM a line at a time and tolerates a great deal
  // around the lines it cares about, and every form below was measured on this
  // container to put the caller's 3072-bit group in force on a real link. Each
  // case asserts the SIZE, not merely that `listen()` resolved: a server that
  // bound and then fell back to the automatic selection would report 2048.
  const TOLERATED_ARMOUR: ReadonlyArray<{ what: string; value: string }> = [
    { what: "CRLF line endings", value: DH_PARAMETERS_3072_PEM.replace(/\n/g, "\r\n") },
    { what: "no final newline", value: DH_PARAMETERS_3072_PEM.trimEnd() },
    {
      what: "trailing spaces after the opening boundary",
      value: DH_PARAMETERS_3072_PEM.replace(BEGIN, BEGIN + "   "),
    },
    {
      what: "explanatory text before the opening boundary",
      value: "the group this site's policy names:\n" + DH_PARAMETERS_3072_PEM,
    },
    {
      what: "explanatory text after the closing boundary",
      value: DH_PARAMETERS_3072_PEM + "and that was the group.\n",
    },
    {
      what: "an indented body",
      value: BEGIN + "\n" + BODY_LINES.map((l) => "    " + l).join("\n") + "\n" + END + "\n",
    },
    { what: "a body unwrapped onto one line", value: BEGIN + "\n" + BODY + "\n" + END + "\n" },
    {
      what: "a byte-order mark in front of it",
      value: String.fromCharCode(0xfeff) + DH_PARAMETERS_3072_PEM,
    },
    {
      what: "another PEM block in front of it",
      value: buildServerCertFixture().cert + DH_PARAMETERS_3072_PEM,
    },
    {
      what: "a blank line opening an empty header section",
      value: BEGIN + "\n\n" + BODY_LINES.join("\n") + "\n" + END + "\n",
    },
    {
      what: "raw bytes rather than a string",
      value: DH_PARAMETERS_3072_PEM,
    },
  ];

  // The same bound, on the body rather than the armour. The optional
  // private-value length is part of the template and the library takes it, so a
  // reader that refused a block for carrying one would refuse parameter files
  // that work; and the library's DER reader is not fussy about a length field
  // written wider than it needs to be. Every form below was measured to put the
  // caller's 3072-bit group in force on a real link.
  const TOLERATED_BODIES: ReadonlyArray<{ what: string; value: string }> = [
    {
      what: "a body rebuilt field by field from the committed group",
      value: parametersFrom(PRIME_FIELD, GENERATOR_FIELD),
    },
    {
      what: "a private-value length of zero",
      value: withExtra(derRawInteger(Buffer.from([0x00]))),
    },
    {
      what: "a private-value length of 256",
      value: withExtra(derInteger(Buffer.from([0x01, 0x00]))),
    },
    {
      what: "a private-value length at the top of the width the library reads",
      value: withExtra(derInteger(Buffer.from([0x7f, 0xff, 0xff, 0xff]))),
    },
    {
      what: "a negative private-value length",
      value: withExtra(derRawInteger(Buffer.from([0xff]))),
    },
    {
      what: "a private-value length with no content octets",
      value: withExtra(derRawInteger(Buffer.alloc(0))),
    },
    {
      what: "a length field on the sequence written wider than it needs to be",
      value: armour(derElement(0x30, Buffer.concat([PRIME_FIELD, GENERATOR_FIELD]), 3)),
    },
    {
      what: "a length field on the generator written wider than it needs to be",
      value: parametersFrom(PRIME_FIELD, derElement(0x02, Buffer.from([0x02]), 2)),
    },
  ];

  for (const tolerated of [...TOLERATED_ARMOUR, ...TOLERATED_BODIES]) {
    it(`${tolerated.what} still puts the caller's group in force`, async () => {
      const { cert, key } = buildServerCertFixture();
      const supplied =
        tolerated.what === "raw bytes rather than a string"
          ? Buffer.from(tolerated.value)
          : tolerated.value;
      const server = trackServer(
        createServer({
          tls: { cert, key, ciphers: DHE_SUITE_OPENSSL, dhParameters: supplied },
        }),
      );
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);

      const observed = await handshake(must(server.getStats().port), cert, DHE_SUITE_OPENSSL);
      expect(observed.suite).toBe(DHE_SUITE_IANA);
      expect(observed.ephemeral.type).toBe("DH");
      expect(observed.ephemeral.size).toBe(DH_PARAMETERS_3072_BITS);
      expect(observed.ephemeral.size).not.toBe(AUTOMATIC_GROUP_BITS);
    });
  }

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
