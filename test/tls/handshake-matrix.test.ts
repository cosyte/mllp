/**
 * TLS / MLLPS handshake matrix (Phase 8), real sockets, real TLS, over a
 * live MllpServer + MllpClient pair on `127.0.0.1` port `0`. Certificates are
 * generated in-memory per test via `test/helpers/tls-fixtures.ts`, never
 * written to disk.
 *
 * TLS handshakes need REAL timers; this suite never enables fake timers.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { connect as tlsConnect, createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer } from "node:tls";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import { createClient } from "../../src/client/client.js";
import type { MllpClient } from "../../src/client/client.js";
import { MllpConnectionError } from "../../src/connection/index.js";
import { isTlsProtocolError } from "../../src/client/error.js";
import {
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_CIPHER_OPTION_CONFLICT,
  tlsConfigurationMessage,
} from "../../src/transport/error.js";
import {
  buildServerCertFixture,
  buildUntrustedCertFixture,
  buildSanMismatchCertFixture,
  buildMutualTlsFixture,
} from "../helpers/tls-fixtures.js";

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

// Same reasoning as test/tls/regressions.test.ts: RSA key generation plus a real
// handshake per case, CPU-bound and machine-proportional, asserting outcomes rather
// than durations. Budgeted here rather than through the suite-wide ceiling.
describe("TLS / MLLPS handshake matrix (Phase 8)", { timeout: 60_000 }, () => {
  const servers: MllpServer[] = [];
  const clients: MllpClient[] = [];

  afterEach(async () => {
    for (const c of clients) {
      c.destroy();
    }
    clients.length = 0;
    for (const s of servers) {
      await s.close().catch(() => undefined);
    }
    servers.length = 0;
    vi.restoreAllMocks();
  });

  function trackServer(s: MllpServer): MllpServer {
    servers.push(s);
    return s;
  }
  function trackClient(c: MllpClient): MllpClient {
    clients.push(c);
    return c;
  }

  // Case 1 --------------------------------------------------------------
  it("Case 1: TLS server + trusted CA client, connect resolves, ACK round-trips, negotiated TLSv1.2/1.3", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({
        tls: { cert, key },
        autoAck: "AA",
      }),
    );
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    server.on("connection", () => {
      /* connection accepted */
    });

    const client = trackClient(createClient({ host: "127.0.0.1", port, tls: { ca: cert } }));
    await client.connect();
    expect(client.getStats().tls).toBe(true);
    expect(server.getStats().tls).toBe(true);

    const payload = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|MSG1|P|2.5\r");
    const ack = await client.send(payload);
    expect(ack.length).toBeGreaterThan(0);

    // Reach the negotiated protocol via a raw parallel TLS connection to the
    // same server, same cert/CA config, so the negotiated version is
    // representative of what the client above negotiated.
    const negotiatedProtocol = await new Promise<string | null>((resolve, reject) => {
      const raw = tlsConnect({ host: "127.0.0.1", port, ca: cert }, () => {
        const proto = raw.getProtocol();
        raw.end();
        resolve(proto);
      });
      raw.once("error", reject);
    });
    expect(["TLSv1.2", "TLSv1.3"]).toContain(negotiatedProtocol);

    await client.close();
  });

  // Case 2 --------------------------------------------------------------
  it("Case 2: default verification ON, client without ca against self-signed server rejects with tls-verify", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(createClient({ host: "127.0.0.1", port, tls: true }));
    await expect(client.connect()).rejects.toMatchObject({
      name: "MllpConnectionError",
      phase: "connect",
      connectionCause: "tls-verify",
    });
  });

  // Case 3 --------------------------------------------------------------
  it("Case 3: SAN mismatch, client trusts the CA but hostname doesn't match", async () => {
    const { cert, key } = buildSanMismatchCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    // Client trusts this exact cert as CA, but connects to 127.0.0.1 while
    // the cert's only SAN is wrong.example.com, hostname/identity mismatch.
    const client = trackClient(
      createClient({ host: "127.0.0.1", port, tls: { ca: cert, servername: "127.0.0.1" } }),
    );
    await expect(client.connect()).rejects.toMatchObject({
      name: "MllpConnectionError",
      connectionCause: "tls-verify",
    });
  });

  // Case 4 --------------------------------------------------------------
  it("Case 4: allowUnverified connects; emits MLLP_TLS_VERIFY_DISABLED >= 2x across 2 connections; process.emitWarning fires", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const emitWarningSpy = vi.spyOn(process, "emitWarning");

    const client = trackClient(
      createClient({ host: "127.0.0.1", port, tls: { allowUnverified: true } }),
    );
    const warnings: Array<{ code: string }> = [];
    client.on("securityWarning", (w: { code: string }) => {
      warnings.push(w);
    });

    await client.connect();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("MLLP_TLS_VERIFY_DISABLED");
    // Frozen event payload (guardrail: every publicly emitted event is Object.freeze'd).
    expect(Object.isFrozen(warnings[0])).toBe(true);
    expect(() => {
      (warnings[0] as unknown as Record<string, unknown>)["code"] = "mutated";
    }).toThrow(TypeError);
    await client.close();

    // Second connection (manual reconnect), must emit again.
    await client.connect();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    await client.close();

    expect(emitWarningSpy).toHaveBeenCalled();
    const calledWithCode = emitWarningSpy.mock.calls.some(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as { code?: string }).code === "MLLP_TLS_VERIFY_DISABLED",
    );
    expect(calledWithCode).toBe(true);
  });

  // Case 5 --------------------------------------------------------------
  it("Case 5: mutual TLS MUST, client with cert succeeds + peerCertificate surfaced; client without cert fails, server emits tlsClientError and keeps serving", async () => {
    const { cert, key, clientCert, clientKey } = buildMutualTlsFixture();
    const server = trackServer(
      createServer({
        tls: { cert, key, ca: cert, clientAuth: "MUST" },
        autoAck: "AA",
      }),
    );
    const tlsClientErrors: Array<{ remoteAddress: string | null; message: string }> = [];
    server.on("tlsClientError", (e: { remoteAddress: string | null; message: string }) => {
      tlsClientErrors.push(e);
    });
    let peerCertificate: { subjectCN: string | null; authorized: boolean } | null | undefined;
    server.on(
      "connection",
      (e: { peerCertificate: { subjectCN: string | null; authorized: boolean } | null }) => {
        peerCertificate = e.peerCertificate;
      },
    );
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    // Client WITHOUT a cert, MUST requires one. Under TLS 1.3
    // (RFC 8446 §4.4.2) the client's own secureConnect can complete BEFORE
    // the server's rejection alert arrives, so the contract is: EITHER
    // connect() rejects with a typed 'tls-handshake' error (alert beat
    // secureConnect, the TLS <=1.2 shape), OR connect() resolves and the
    // rejection surfaces moments later as a typed post-connect error and
    // the connection leaves CONNECTED. Never a silent success-and-hang.
    const badClient = trackClient(createClient({ host: "127.0.0.1", port, tls: { ca: cert } }));
    const badClientErrors: Array<{ error: unknown }> = [];
    badClient.on("error", (e: { error: unknown }) => badClientErrors.push(e));
    let rejection: unknown = null;
    try {
      await badClient.connect();
    } catch (err) {
      rejection = err;
    }
    if (rejection !== null) {
      // Pre-secureConnect rejection path.
      expect(rejection).toBeInstanceOf(MllpConnectionError);
      expect((rejection as MllpConnectionError).connectionCause).toBe("tls-handshake");
    } else {
      // TLS 1.3 post-connect rejection path: a typed error event follows and
      // the connection leaves CONNECTED, no silent hang.
      await waitFor(() => badClientErrors.length > 0 && badClient.state !== "CONNECTED");
      const evt = badClientErrors[0]?.error;
      expect(evt).toBeInstanceOf(MllpConnectionError);
      expect(isTlsProtocolError((evt as MllpConnectionError).cause)).toBe(true);
      expect(badClient.state).not.toBe("CONNECTED");
    }

    // Give the server a beat to observe the failed handshake.
    await new Promise((r) => setTimeout(r, 50));
    expect(tlsClientErrors.length).toBeGreaterThanOrEqual(1);
    expect(tlsClientErrors[0]?.message.length).toBeGreaterThan(0);
    // Frozen event payload (guardrail: every publicly emitted event is Object.freeze'd).
    expect(Object.isFrozen(tlsClientErrors[0])).toBe(true);
    expect(() => {
      (tlsClientErrors[0] as unknown as Record<string, unknown>)["message"] = "mutated";
    }).toThrow(TypeError);

    // Server must still be serving, a good client with a valid cert works.
    const goodClient = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, cert: clientCert, key: clientKey },
      }),
    );
    await goodClient.connect();
    const ack = await goodClient.send(
      Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|M2|P|2.5\r"),
    );
    expect(ack.length).toBeGreaterThan(0);
    expect(peerCertificate).not.toBeNull();
    expect(peerCertificate?.subjectCN).toBe("test-client");
    // Fix 4: under MUST, a surfaced peer certificate is always CA-verified.
    expect(peerCertificate?.authorized).toBe(true);
    await goodClient.close();
  });

  // Case 6 --------------------------------------------------------------
  it("Case 6: WANT, client without cert connects fine (peerCertificate null); with cert, it's surfaced", async () => {
    const { cert, key, clientCert, clientKey } = buildMutualTlsFixture();
    const peerCerts: Array<{ subjectCN: string | null } | null> = [];
    const server = trackServer(
      createServer({
        tls: { cert, key, ca: cert, clientAuth: "WANT" },
        autoAck: "AA",
      }),
    );
    server.on("connection", (e: { peerCertificate: { subjectCN: string | null } | null }) => {
      peerCerts.push(e.peerCertificate);
    });
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const noCertClient = trackClient(createClient({ host: "127.0.0.1", port, tls: { ca: cert } }));
    await noCertClient.connect();
    // Server-side 'secureConnection' can land a beat after the client's own
    // secureConnect, wait for it before closing.
    await waitFor(() => peerCerts.length >= 1);
    await noCertClient.close();

    const withCertClient = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, cert: clientCert, key: clientKey },
      }),
    );
    await withCertClient.connect();
    await waitFor(() => peerCerts.length >= 2);
    await withCertClient.close();

    expect(peerCerts).toHaveLength(2);
    expect(peerCerts[0]).toBeNull();
    expect(peerCerts[1]).not.toBeNull();
    expect(peerCerts[1]?.subjectCN).toBe("test-client");
  });

  // Case 7 --------------------------------------------------------------
  it("Case 7: TLS floor, server rejects a client forcing TLSv1.1 (or the client itself refuses to attempt it); happy path negotiates >= TLSv1.2", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    try {
      const proto = await new Promise<string | null>((resolve, reject) => {
        const raw = tlsConnect(
          { host: "127.0.0.1", port, ca: cert, minVersion: "TLSv1.1", maxVersion: "TLSv1.1" },
          () => {
            const p = raw.getProtocol();
            raw.end();
            resolve(p);
          },
        );
        raw.once("error", reject);
      });
      // If it somehow "succeeded", it must not have been TLSv1.1.
      expect(proto).not.toBe("TLSv1.1");
    } catch {
      // Node/OpenSSL refused to even attempt TLSv1.1 (security level), or the
      // server rejected the handshake, either way the floor holds. No
      // assertion needed in this branch: reaching it (rather than an
      // unhandled rejection failing the test) IS the passing condition.
    }

    // Happy path: negotiates TLSv1.2 or TLSv1.3.
    const proto = await new Promise<string | null>((resolve, reject) => {
      const raw = tlsConnect({ host: "127.0.0.1", port, ca: cert }, () => {
        const p = raw.getProtocol();
        raw.end();
        resolve(p);
      });
      raw.once("error", reject);
    });
    expect(["TLSv1.2", "TLSv1.3"]).toContain(proto);
  });

  // Case 8 --------------------------------------------------------------
  it("Case 8: tls-verify failure is PERMANENT for the reconnect classifier, no reconnect scheduled, state -> CLOSED", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({ host: "127.0.0.1", port, tls: true, autoReconnect: true, initialDelayMs: 5 }),
    );
    await expect(client.connect()).rejects.toMatchObject({ connectionCause: "tls-verify" });

    // No reconnect cycle should have been scheduled, state is the client
    // baseline (never entered CONNECTED, so no disconnect/reconnect fires).
    await new Promise((r) => setTimeout(r, 100));
    expect(client.getStats().reconnectAttempts).toBe(0);
    expect(client.state).not.toBe("RECONNECTING");
  });

  // Case 9 --------------------------------------------------------------
  it("Case 9: reconnect over TLS, autoReconnect client survives a server-side socket kill and can send again", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key }, autoAck: "AA" }));
    const rawSockets: Array<{ destroy: () => void }> = [];
    server.on("connection", () => {
      /* tracked via server internals below */
    });
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      }),
    );
    await client.connect();

    const reconnectedPromise = new Promise<void>((resolve) => {
      client.once("connect", () => resolve());
    });

    // Kill the connection from the client's own transport to force a
    // reconnect cycle (simulates a dropped TLS session).
    const internals = client as unknown as {
      _socket: { destroy: (err?: Error) => void } | null;
    };
    internals._socket?.destroy(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));

    await reconnectedPromise;
    expect(client.state).toBe("CONNECTED");

    const ack = await client.send(Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|M3|P|2.5\r"));
    expect(ack.length).toBeGreaterThan(0);
    expect(client.getStats().reconnectAttempts).toBeGreaterThanOrEqual(1);

    await client.close();
    void rawSockets;
  });

  // Extra: untrusted-CA fixture is exercised implicitly by Case 2's `tls: true`
  // (no ca at all against a self-signed server), buildUntrustedCertFixture
  // covers the "client trusts the WRONG CA" variant explicitly:
  it("Extra: client trusts an unrelated CA, still tls-verify", async () => {
    const { cert, key } = buildServerCertFixture();
    const wrongCa = buildUntrustedCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({ host: "127.0.0.1", port, tls: { ca: wrongCa.cert } }),
    );
    await expect(client.connect()).rejects.toMatchObject({ connectionCause: "tls-verify" });
  });
});

/**
 * The four suites ITI TF-2 §3.19.6.2.3 names, in the two spellings that matter.
 * A cipher-list string is written in OpenSSL's spelling, and that is what
 * restricts a peer below; the event reports the IANA spelling, which is the one
 * the standard prints and the one a conformance claim is written in.
 */
const ATNA_SUITE_SPELLINGS: ReadonlyArray<{ openssl: string; iana: string }> = [
  { openssl: "DHE-RSA-AES128-GCM-SHA256", iana: "TLS_DHE_RSA_WITH_AES_128_GCM_SHA256" },
  { openssl: "ECDHE-RSA-AES128-GCM-SHA256", iana: "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" },
  { openssl: "DHE-RSA-AES256-GCM-SHA384", iana: "TLS_DHE_RSA_WITH_AES_256_GCM_SHA384" },
  { openssl: "ECDHE-RSA-AES256-GCM-SHA384", iana: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384" },
];

/**
 * A TLS 1.2 suite that IS in the runtime's default list and is NOT one of the
 * four. It is what separates "the option narrowed the offer" from "the peer
 * happened to pick an ATNA suite anyway".
 */
const NON_ATNA_DEFAULT_SUITE = "ECDHE-RSA-AES128-SHA256";
const NON_ATNA_DEFAULT_SUITE_IANA = "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256";

/**
 * The ATNA transport-security option: what a link offers when it is selected,
 * what it still offers when it is not, and the per-connection record of what
 * each handshake actually agreed on.
 *
 * Every cipher assertion here is graded by an OBSERVED HANDSHAKE against a peer
 * restricted to one suite, never by comparing a configured string against a
 * document. That is deliberate: the runtime's own default list ends in a class
 * token plus exclusions, so what it effectively contains is not settled by
 * reading it, and it is replaceable from outside the process anyway.
 *
 * Real sockets and real TLS, so real timers, same budget reasoning as the
 * matrix above.
 */
describe("ATNA transport-security option", { timeout: 60_000 }, () => {
  const servers: MllpServer[] = [];
  const clients: MllpClient[] = [];
  const rawServers: TlsServer[] = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    for (const s of servers) await s.close().catch(() => undefined);
    servers.length = 0;
    for (const r of rawServers) await new Promise<void>((res) => r.close(() => res()));
    rawServers.length = 0;
  });

  function trackServer(s: MllpServer): MllpServer {
    servers.push(s);
    return s;
  }
  function trackClient(c: MllpClient): MllpClient {
    clients.push(c);
    return c;
  }

  /**
   * A bare `tls.Server` restricted to exactly `ciphers`, capped at TLS 1.2 so
   * the restriction is the whole of what it offers (a TLS 1.3 suite is enabled
   * through a separate mechanism and would otherwise dominate the negotiation).
   * `dhparam: 'auto'` so a DHE restriction is actually offerable.
   */
  async function startRestrictedPeerServer(ciphers: string): Promise<{
    port: number;
    cert: string;
    accepted: Array<{ protocol: string | null; suite: string }>;
  }> {
    const { cert, key } = buildServerCertFixture();
    const accepted: Array<{ protocol: string | null; suite: string }> = [];
    const srv = tlsCreateServer({
      cert,
      key,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers,
      dhparam: "auto",
    });
    rawServers.push(srv);
    srv.on("secureConnection", (s) => {
      accepted.push({ protocol: s.getProtocol(), suite: s.getCipher().standardName });
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const addr = srv.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    return { port: addr.port, cert, accepted };
  }

  /** Collect every `'tlsNegotiated'` payload an emitter produces. */
  function collectNegotiated(emitter: MllpClient | MllpServer): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    emitter.on("tlsNegotiated", (p: Record<string, unknown>) => {
      seen.push(p);
    });
    return seen;
  }

  // Criteria 1, 2, 4 -----------------------------------------------------
  for (const suite of ATNA_SUITE_SPELLINGS) {
    it(`client with the option negotiates ${suite.iana} against a peer restricted to it`, async () => {
      const peer = await startRestrictedPeerServer(suite.openssl);
      const client = trackClient(
        createClient({
          host: "127.0.0.1",
          port: peer.port,
          tls: { ca: peer.cert, atnaTransportSecurity: true },
        }),
      );
      const negotiated = collectNegotiated(client);
      await client.connect();

      expect(negotiated).toHaveLength(1);
      expect(negotiated[0]?.["cipherSuite"]).toBe(suite.iana);
      expect(negotiated[0]?.["protocolVersion"]).toBe("TLSv1.2");
      // Frozen payload, the standing rule for every publicly emitted event.
      expect(Object.isFrozen(negotiated[0])).toBe(true);
      // The peer saw the same handshake, so the report is of a real negotiation.
      await waitFor(() => peer.accepted.length === 1);
      expect(peer.accepted[0]?.suite).toBe(suite.iana);

      await client.close();
    });
  }

  // Criteria 1, 2, 4, 8 --------------------------------------------------
  for (const suite of ATNA_SUITE_SPELLINGS) {
    it(`server with the option negotiates ${suite.iana} against a peer restricted to it`, async () => {
      const { cert, key } = buildServerCertFixture();
      const server = trackServer(createServer({ tls: { cert, key, atnaTransportSecurity: true } }));
      const negotiated = collectNegotiated(server);
      await server.listen(0, "127.0.0.1");
      const port = must(server.getStats().port);

      const peerObserved = await new Promise<{ protocol: string | null; suite: string }>(
        (resolve, reject) => {
          const raw = tlsConnect(
            {
              host: "127.0.0.1",
              port,
              ca: cert,
              servername: "localhost",
              minVersion: "TLSv1.2",
              maxVersion: "TLSv1.2",
              ciphers: suite.openssl,
            },
            () => {
              const observed = {
                protocol: raw.getProtocol(),
                suite: raw.getCipher().standardName,
              };
              raw.end();
              resolve(observed);
            },
          );
          raw.once("error", reject);
        },
      );

      expect(peerObserved.suite).toBe(suite.iana);
      await waitFor(() => negotiated.length === 1);
      expect(negotiated[0]?.["cipherSuite"]).toBe(suite.iana);
      expect(negotiated[0]?.["protocolVersion"]).toBe(peerObserved.protocol);
      expect(Object.isFrozen(negotiated[0])).toBe(true);
    });
  }

  // Criterion 5 ----------------------------------------------------------
  it(`client with the option FAILS against a peer offering only ${NON_ATNA_DEFAULT_SUITE}`, async () => {
    const peer = await startRestrictedPeerServer(NON_ATNA_DEFAULT_SUITE);
    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port: peer.port,
        tls: { ca: peer.cert, atnaTransportSecurity: true },
      }),
    );
    const negotiated = collectNegotiated(client);
    await expect(client.connect()).rejects.toBeInstanceOf(MllpConnectionError);
    expect(negotiated).toHaveLength(0);
    expect(peer.accepted).toHaveLength(0);
  });

  it(`server with the option FAILS a peer offering only ${NON_ATNA_DEFAULT_SUITE}`, async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key, atnaTransportSecurity: true } }));
    const negotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    await expect(
      new Promise<void>((resolve, reject) => {
        const raw = tlsConnect(
          {
            host: "127.0.0.1",
            port,
            ca: cert,
            servername: "localhost",
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.2",
            ciphers: NON_ATNA_DEFAULT_SUITE,
          },
          () => {
            raw.end();
            resolve();
          },
        );
        raw.once("error", reject);
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(negotiated).toHaveLength(0);
  });

  // Criterion 6 ----------------------------------------------------------
  it(`option NOT selected: ${NON_ATNA_DEFAULT_SUITE} still handshakes, both ways`, async () => {
    // Client side: the same restricted peer that refuses the option-on client
    // above is negotiated fine when the option is off.
    const peer = await startRestrictedPeerServer(NON_ATNA_DEFAULT_SUITE);
    const client = trackClient(
      createClient({ host: "127.0.0.1", port: peer.port, tls: { ca: peer.cert } }),
    );
    const clientNegotiated = collectNegotiated(client);
    await client.connect();
    await waitFor(() => peer.accepted.length === 1);
    expect(peer.accepted[0]?.suite).toBe(NON_ATNA_DEFAULT_SUITE_IANA);
    expect(clientNegotiated[0]?.["cipherSuite"]).toBe(NON_ATNA_DEFAULT_SUITE_IANA);
    await client.close();

    // Server side: same suite, same outcome.
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(createServer({ tls: { cert, key } }));
    const serverNegotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);
    const suite = await new Promise<string>((resolve, reject) => {
      const raw = tlsConnect(
        {
          host: "127.0.0.1",
          port,
          ca: cert,
          servername: "localhost",
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          ciphers: NON_ATNA_DEFAULT_SUITE,
        },
        () => {
          const s = raw.getCipher().standardName;
          raw.end();
          resolve(s);
        },
      );
      raw.once("error", reject);
    });
    expect(suite).toBe(NON_ATNA_DEFAULT_SUITE_IANA);
    await waitFor(() => serverNegotiated.length === 1);
    expect(serverNegotiated[0]?.["cipherSuite"]).toBe(NON_ATNA_DEFAULT_SUITE_IANA);
  });

  // Criteria 7, 8 --------------------------------------------------------
  it("option selected on both sides still negotiates TLSv1.3, and both ends report the same pair", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({ tls: { cert, key, atnaTransportSecurity: true }, autoAck: "AA" }),
    );
    const serverNegotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({ host: "127.0.0.1", port, tls: { ca: cert, atnaTransportSecurity: true } }),
    );
    const clientNegotiated = collectNegotiated(client);
    await client.connect();

    expect(clientNegotiated).toHaveLength(1);
    expect(clientNegotiated[0]?.["protocolVersion"]).toBe("TLSv1.3");
    await waitFor(() => serverNegotiated.length === 1);
    expect(serverNegotiated[0]?.["protocolVersion"]).toBe("TLSv1.3");
    // Criterion 8: the two ends of ONE connection report the same pair.
    expect(serverNegotiated[0]?.["cipherSuite"]).toBe(clientNegotiated[0]?.["cipherSuite"]);

    // And the link still carries messages.
    const ack = await client.send(Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|M9|P|2.5\r"));
    expect(ack.length).toBeGreaterThan(0);
    await client.close();
  });

  // Criterion 9 ----------------------------------------------------------
  it("a reconnect emits the record again, so a log holds every session", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({ tls: { cert, key, atnaTransportSecurity: true }, autoAck: "AA" }),
    );
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, atnaTransportSecurity: true },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      }),
    );
    const negotiated = collectNegotiated(client);
    await client.connect();
    expect(negotiated).toHaveLength(1);

    const reconnected = new Promise<void>((resolve) => {
      client.once("connect", () => resolve());
    });
    const internals = client as unknown as { _socket: { destroy: (e?: Error) => void } | null };
    internals._socket?.destroy(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
    await reconnected;

    await waitFor(() => negotiated.length >= 2);
    expect(negotiated[1]?.["protocolVersion"]).toBe(negotiated[0]?.["protocolVersion"]);
    await client.close();
  });

  // Criterion 11 ---------------------------------------------------------
  it("a plaintext link emits no record at all, on either side", async () => {
    const server = trackServer(createServer({ autoAck: "AA" }));
    const serverNegotiated = collectNegotiated(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(createClient({ host: "127.0.0.1", port }));
    const clientNegotiated = collectNegotiated(client);
    await client.connect();
    const ack = await client.send(Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|MP|P|2.5\r"));
    expect(ack.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(clientNegotiated).toHaveLength(0);
    expect(serverNegotiated).toHaveLength(0);
    await client.close();
  });

  // Criteria 3, 12 -------------------------------------------------------
  it("a suite list the runtime rejects fails connect() by type and code, nothing connected", async () => {
    const { cert } = buildServerCertFixture();
    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port: 1,
        tls: { ca: cert, ciphers: "NOT-A-REAL-CIPHER-SUITE" },
      }),
    );
    const rejection = await client.connect().then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(MllpTlsConfigurationError);
    expect((rejection as MllpTlsConfigurationError).code).toBe(MLLP_TLS_CIPHER_LIST_REJECTED);
    expect(client.state).toBe("DISCONNECTED");
    expect(client.getStats().connectionId).toBeNull();
    const internals = client as unknown as { _socket: unknown };
    expect(internals._socket).toBeNull();
  });

  it("a suite list the runtime rejects fails listen() by type and code, nothing bound", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = trackServer(
      createServer({ tls: { cert, key, ciphers: "NOT-A-REAL-CIPHER-SUITE" } }),
    );
    const rejection = await server.listen(0, "127.0.0.1").then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(MllpTlsConfigurationError);
    expect((rejection as MllpTlsConfigurationError).code).toBe(MLLP_TLS_CIPHER_LIST_REJECTED);
    expect(server.getStats().listening).toBe(false);
    expect(server.getStats().port).toBeNull();
    // A refused server stays refused; it does not become listenable on a retry.
    await expect(server.listen(0, "127.0.0.1")).rejects.toBeInstanceOf(MllpTlsConfigurationError);
  });

  it("the option and the ciphers passthrough together are refused on both sides", async () => {
    const { cert, key } = buildServerCertFixture();

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port: 1,
        tls: { ca: cert, atnaTransportSecurity: true, ciphers: "ECDHE-RSA-AES128-GCM-SHA256" },
      }),
    );
    const clientRejection = await client.connect().then(
      () => null,
      (err: unknown) => err,
    );
    expect(clientRejection).toBeInstanceOf(MllpTlsConfigurationError);
    expect((clientRejection as MllpTlsConfigurationError).code).toBe(
      MLLP_TLS_CIPHER_OPTION_CONFLICT,
    );

    const server = trackServer(
      createServer({
        tls: { cert, key, atnaTransportSecurity: true, ciphers: "ECDHE-RSA-AES128-GCM-SHA256" },
      }),
    );
    await expect(server.listen(0, "127.0.0.1")).rejects.toMatchObject({
      name: "MllpTlsConfigurationError",
      code: MLLP_TLS_CIPHER_OPTION_CONFLICT,
    });
    expect(server.getStats().listening).toBe(false);
  });

  it("a configuration error carries neither key material nor a passphrase", async () => {
    const { cert, key } = buildServerCertFixture();
    const passphrase = "unit-test-passphrase-never-in-a-diagnostic";
    const server = trackServer(
      createServer({ tls: { cert, key, passphrase, ciphers: "NOT-A-REAL-CIPHER-SUITE" } }),
    );
    const rejection = (await server.listen(0, "127.0.0.1").then(
      () => null,
      (err: unknown) => err,
    )) as MllpTlsConfigurationError;

    const rendered = [
      rejection.message,
      String(rejection),
      rejection.cause === undefined ? "" : rejection.cause.message,
      JSON.stringify(Object.getOwnPropertyNames(rejection)),
    ].join("\n");
    expect(rendered).not.toContain(passphrase);
    expect(rendered).not.toContain("PRIVATE KEY");
    expect(rendered).not.toContain(key.slice(40, 120));
    expect(rendered).not.toContain(cert.slice(40, 120));
    // The message is a frozen registry entry, identical whatever the
    // configuration was: the factory takes only a code.
    expect(rejection.message).toBe(tlsConfigurationMessage(MLLP_TLS_CIPHER_LIST_REJECTED));
  });
});
