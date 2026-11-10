/**
 * TLS options that reach the socket only on request: a passphrase for an encrypted key (both
 * ends), a protocol ceiling on the server, a failed handshake whose error carries no code, and a
 * client certificate whose names are unusual (two CNs, an issuer with no CN). Certificates are
 * generated in memory per run; no file and no real identity is involved.
 */

import forge from "node-forge";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import type { NegotiatedTlsParameters } from "../../src/transport/negotiated-tls.js";
import { buildMutualTlsFixture, buildServerCertFixture } from "../helpers/tls-fixtures.js";

const PASSPHRASE = "synthetic-test-passphrase";
const MESSAGE = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|MSG1|P|2.5\r", "latin1");

function encryptKey(pem: string): string {
  return forge.pki.encryptRsaPrivateKey(forge.pki.privateKeyFromPem(pem), PASSPHRASE, {
    algorithm: "aes256",
  });
}

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const servers: MllpServer[] = [];
const clients: MllpClient[] = [];

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  clients.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
});

describe("TLS: encrypted keys and a protocol ceiling", () => {
  it("unlocks both keys with their passphrases and holds the link to TLSv1.2", async () => {
    const { cert, key, clientCert, clientKey } = buildMutualTlsFixture();
    const server = createServer({
      tls: {
        cert,
        key: encryptKey(key),
        passphrase: PASSPHRASE,
        ca: cert,
        clientAuth: "MUST",
        maxVersion: "TLSv1.2",
      },
      autoAck: "AA",
    });
    servers.push(server);
    await server.listen(0, "127.0.0.1");

    const client = createClient({
      host: "127.0.0.1",
      port: must(server.getStats().port),
      tls: { ca: cert, cert: clientCert, key: encryptKey(clientKey), passphrase: PASSPHRASE },
    });
    clients.push(client);
    const negotiated: NegotiatedTlsParameters[] = [];
    client.on("tlsNegotiated", (p: NegotiatedTlsParameters) => negotiated.push(p));

    await client.connect();
    const ack = await client.send(MESSAGE);

    expect(ack.toString("latin1")).toContain("MSA|AA|MSG1");
    expect(negotiated).toHaveLength(1);
    expect(negotiated[0]?.protocolVersion).toBe("TLSv1.2");
  });
});

describe("TLS: a failed handshake whose error carries no code", () => {
  it("reports code null and null address fields on 'tlsClientError'", () => {
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key } });
    servers.push(server);
    const events: Array<{
      code: string | null;
      message: string;
      remoteAddress: string | null;
      remotePort: number | null;
    }> = [];
    server.on("tlsClientError", (e: (typeof events)[number]) => events.push(e));

    // Fault injection on the underlying tls.Server: an error with no `code`, on a socket that
    // has already lost its address.
    const internals = server as unknown as { _netServer: net.Server };
    internals._netServer.emit("tlsClientError", new Error("handshake failed"), new net.Socket());

    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBeNull();
    expect(events[0]?.message).toBe("handshake failed");
    expect(events[0]?.remoteAddress).toBeNull();
    expect(events[0]?.remotePort).toBeNull();
    expect(server.getStats().tlsClientErrorsTotal).toBe(1);
  });
});

/** A self-signed client certificate with two CNs and an issuer that has no CN at all. */
function oddlyNamedClientCert(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey;
  c.serialNumber = "0a";
  c.validity.notBefore = new Date();
  c.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  c.setSubject([
    { name: "commonName", value: "synthetic-first" },
    { name: "commonName", value: "synthetic-second" },
  ]);
  c.setIssuer([{ name: "organizationName", value: "Synthetic Test Org" }]);
  c.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

describe("TLS clientAuth 'WANT': an unverified client certificate with unusual names", () => {
  it("summarises the first subject CN, a null issuer CN, and authorized false", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key, ca: cert, clientAuth: "WANT" } });
    servers.push(server);
    const summaries: Array<{
      subjectCN: string | null;
      issuerCN: string | null;
      validTo: string | null;
      authorized: boolean;
    } | null> = [];
    server.on("connection", (e: { peerCertificate: (typeof summaries)[number] }) =>
      summaries.push(e.peerCertificate),
    );
    await server.listen(0, "127.0.0.1");

    const odd = oddlyNamedClientCert();
    const client = createClient({
      host: "127.0.0.1",
      port: must(server.getStats().port),
      tls: { ca: cert, cert: odd.cert, key: odd.key },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => summaries.length === 1);

    const summary = summaries[0];
    expect(summary?.subjectCN).toBe("synthetic-first");
    expect(summary?.issuerCN).toBeNull();
    expect(typeof summary?.validTo).toBe("string");
    expect(summary?.authorized).toBe(false);
  });
});
