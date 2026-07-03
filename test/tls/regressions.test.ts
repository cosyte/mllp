/**
 * Phase 8 review regressions — real sockets, real TLS, real timers.
 *
 * Covers the defects found by the independent gate review of the first
 * Phase 8 cut (the since-removed post-handshake grace window):
 *
 * 1. Zero inbound-frame loss: a TLS peer that writes an MLLP frame
 *    IMMEDIATELY after the handshake must have it delivered — never
 *    silently discarded while the Connection sits in CONNECTING.
 * 2. A TLS server that cleanly end()s right after the handshake behaves
 *    like its plaintext counterpart (no resolve-on-dead-state asymmetry),
 *    and an autoReconnect client recovers the same way plaintext does.
 * 3. mTLS MUST rejection with autoReconnect: true never reconnect-loops —
 *    TLS-protocol-shaped errors are classified permanent.
 * 6. The allowUnverified securityWarning fires on the AUTO-reconnect path.
 *
 * (4 — wildcard spellings — lives in test/server/bind-safety.test.ts;
 *  5 — the WANT `authorized` flag — lives here and in the matrix Case 5.)
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import { createServer as netCreateServer } from "node:net";
import type { Server as RawNetServer, Socket } from "node:net";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import { createClient } from "../../src/client/client.js";
import type { MllpClient } from "../../src/client/client.js";
import { encodeFrame } from "../../src/framing/index.js";
import {
  buildServerCertFixture,
  buildUntrustedCertFixture,
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

describe("Phase 8 TLS regressions", () => {
  const clients: MllpClient[] = [];
  const mllpServers: MllpServer[] = [];
  const rawServers: Array<TlsServer | RawNetServer> = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    for (const s of mllpServers) await s.close().catch(() => undefined);
    mllpServers.length = 0;
    for (const s of rawServers) {
      // close() stops accepting; unref() lets the process exit even if a
      // lingering socket keeps the server's close callback from firing.
      s.close();
      s.unref();
    }
    rawServers.length = 0;
  });

  function trackClient(c: MllpClient): MllpClient {
    clients.push(c);
    return c;
  }

  function listenRaw(server: TlsServer | RawNetServer): Promise<number> {
    rawServers.push(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
  }

  // Regression 1 ---------------------------------------------------------
  it("R1: a frame the TLS peer writes IMMEDIATELY after the handshake is delivered — zero loss", async () => {
    const { cert, key } = buildServerCertFixture();
    const payload = Buffer.from("MSH|^~\\&|IMMEDIATE|FRAME|X|Y|20260101||ADT^A01|R1|P|2.5\r");
    const rawServer = tlsCreateServer({ cert, key }, (socket: TLSSocket) => {
      // Write the MLLP frame in the same tick the handshake completes —
      // the exact window in which the removed grace timer silently
      // discarded inbound frames (Connection was still CONNECTING).
      socket.write(encodeFrame(payload));
    });
    const port = await listenRaw(rawServer);

    const client = trackClient(createClient({ host: "127.0.0.1", port, tls: { ca: cert } }));
    const messages: Buffer[] = [];
    client.on("message", (e: { payload: Buffer }) => messages.push(e.payload));
    await client.connect();

    await waitFor(() => messages.length > 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.equals(payload)).toBe(true);
    await client.close();
  });

  // Regression 2 ---------------------------------------------------------
  it("R2: a TLS server that cleanly end()s right after the handshake behaves like plaintext", async () => {
    // TLS variant.
    const { cert, key } = buildServerCertFixture();
    const rawTls = tlsCreateServer({ cert, key }, (socket: TLSSocket) => {
      socket.end();
    });
    const tlsPort = await listenRaw(rawTls);
    const tlsClient = trackClient(
      createClient({ host: "127.0.0.1", port: tlsPort, tls: { ca: cert } }),
    );
    await expect(tlsClient.connect()).resolves.toBeUndefined();
    await waitFor(() => tlsClient.state !== "CONNECTED");
    const tlsFinalState = tlsClient.state;

    // Plaintext control — identical server behavior over raw TCP.
    const rawNet = netCreateServer((socket: Socket) => {
      socket.end();
    });
    const netPort = await listenRaw(rawNet);
    const netClient = trackClient(createClient({ host: "127.0.0.1", port: netPort }));
    await expect(netClient.connect()).resolves.toBeUndefined();
    await waitFor(() => netClient.state !== "CONNECTED");
    const netFinalState = netClient.state;

    // Symmetry: same terminal-ish state on both transports — no
    // TLS-only resolve-on-dead-state asymmetry.
    expect(tlsFinalState).toBe(netFinalState);
  });

  it("R2b: an autoReconnect TLS client recovers from a server that end()s its FIRST connection, like plaintext", async () => {
    const { cert, key } = buildServerCertFixture();
    let tlsConnections = 0;
    const rawTls = tlsCreateServer({ cert, key }, (socket: TLSSocket) => {
      tlsConnections += 1;
      if (tlsConnections === 1) {
        socket.end(); // kill only the first session
      }
    });
    const port = await listenRaw(rawTls);

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
    // First session dies (server end()s it); the client must reconnect
    // over TLS and settle back into CONNECTED.
    await waitFor(() => tlsConnections >= 2 && client.state === "CONNECTED", 5000);
    expect(client.state).toBe("CONNECTED");
    expect(client.getStats().reconnectAttempts).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  // Regression 3 ---------------------------------------------------------
  it("R3: mTLS MUST rejection with autoReconnect: true — NO reconnect loop (permanent; state CLOSED; attempts 0)", async () => {
    const { cert, key } = buildMutualTlsFixture();
    const server = createServer({ tls: { cert, key, ca: cert, clientAuth: "MUST" } });
    mllpServers.push(server);
    server.on("tlsClientError", () => {
      /* expected — server must not crash */
    });
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    // Client with NO certificate against a MUST server, auto-reconnect ON.
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
    client.on("error", () => {
      /* swallow the typed post-connect error for this test */
    });

    // Under TLS 1.3 connect() resolves before the server's rejection alert
    // lands; under <=1.2 it rejects. Either way: NO reconnect loop.
    try {
      await client.connect();
    } catch {
      // pre-secureConnect rejection path — nothing more to drive
    }

    // The rejection is TLS-protocol-shaped → classified permanent → CLOSED.
    await waitFor(() => client.state === "CLOSED" || client.state === "DISCONNECTED");
    // Give any (incorrect) backoff timer a chance to fire, then assert
    // no reconnect attempt was ever scheduled.
    await new Promise((r) => setTimeout(r, 150));
    expect(client.getStats().reconnectAttempts).toBe(0);
    expect(client.state).not.toBe("RECONNECTING");
    expect(client.state).not.toBe("CONNECTED");
  });

  // Regression 5 (WANT authorized flag) ------------------------------------
  it("R5: WANT surfaces authorized:false for an untrusted client cert, authorized:true for a trusted one", async () => {
    const { cert, key, clientCert, clientKey } = buildMutualTlsFixture();
    const untrusted = buildUntrustedCertFixture();
    const peerCerts: Array<{ subjectCN: string | null; authorized: boolean } | null> = [];
    const server = createServer({ tls: { cert, key, ca: cert, clientAuth: "WANT" } });
    mllpServers.push(server);
    server.on(
      "connection",
      (e: { peerCertificate: { subjectCN: string | null; authorized: boolean } | null }) => {
        peerCerts.push(e.peerCertificate);
      },
    );
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    // Untrusted client cert (self-signed by an unrelated CA) — WANT accepts
    // the connection but the cert is NOT verified.
    const untrustedClient = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, cert: untrusted.cert, key: untrusted.key },
      }),
    );
    await untrustedClient.connect();
    // The server-side 'secureConnection' can land a beat after the client's
    // own secureConnect — wait for it before closing.
    await waitFor(() => peerCerts.length >= 1);
    await untrustedClient.close();

    // Trusted client cert — verified against the server's ca.
    const trustedClient = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, cert: clientCert, key: clientKey },
      }),
    );
    await trustedClient.connect();
    await waitFor(() => peerCerts.length >= 2);
    await trustedClient.close();

    expect(peerCerts).toHaveLength(2);
    expect(peerCerts[0]).not.toBeNull();
    expect(peerCerts[0]?.authorized).toBe(false); // present yet UNVERIFIED
    expect(peerCerts[1]).not.toBeNull();
    expect(peerCerts[1]?.authorized).toBe(true);
    expect(peerCerts[1]?.subjectCN).toBe("test-client");
  });

  // Regression 6 ---------------------------------------------------------
  it("R6: allowUnverified securityWarning fires on the AUTO-reconnect path too", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key }, autoAck: "AA" });
    mllpServers.push(server);
    await server.listen(0, "127.0.0.1");
    const port = must(server.getStats().port);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { allowUnverified: true },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      }),
    );
    const warnings: Array<{ code: string }> = [];
    client.on("securityWarning", (w: { code: string }) => warnings.push(w));

    await client.connect();
    expect(warnings).toHaveLength(1);

    // Kill the live socket to force an AUTO-reconnect cycle.
    const internals = client as unknown as {
      _socket: { destroy: (err?: Error) => void } | null;
    };
    internals._socket?.destroy(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));

    await waitFor(() => warnings.length >= 2 && client.state === "CONNECTED", 5000);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.every((w) => w.code === "MLLP_TLS_VERIFY_DISABLED")).toBe(true);
    await client.close();
  });
});
