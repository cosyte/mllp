/**
 * The SNI server name and the identity check when the client's host is an IP
 * address.
 *
 * RFC 6066 allows only host names as an SNI server name, and Node 26 throws
 * `ERR_INVALID_ARG_VALUE` when `tls.connect` is handed an IP `servername`. The
 * client used to pass `ClientOptions.host` as the server name unconditionally,
 * so every TLS connection to an address literal failed on Node 26. These cases
 * pin the fix from both sides: an IP address is never sent as SNI, and the
 * server certificate is still checked against that IP address, so dropping
 * the SNI never drops the identity check.
 *
 * Real sockets and real TLS against a bare `node:tls` server on `127.0.0.1`,
 * which records the server name each handshake asked for. Certificates are
 * generated in memory and never written to disk.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { generate } from "selfsigned";
import { createClient } from "../../src/client/client.js";
import type { MllpClient } from "../../src/client/client.js";
import { buildServerCertFixture, buildSanMismatchCertFixture } from "../helpers/tls-fixtures.js";

/** A listening TLS server and the SNI server name of every handshake it completed. */
interface RecordingServer {
  readonly port: number;
  readonly serverNames: Array<string | false | null>;
}

/**
 * Wait until `server` has completed `count` handshakes. The client's
 * `secureConnect` can fire before the server's `secureConnection` does (in
 * TLS 1.3 the client finishes first), so the record is awaited, not read.
 *
 * @param server - The recording server.
 * @param count - How many completed handshakes to wait for.
 */
async function handshakes(
  server: RecordingServer,
  count: number,
): Promise<Array<string | false | null>> {
  const start = Date.now();
  while (server.serverNames.length < count) {
    if (Date.now() - start > 5_000) throw new Error("the server completed no handshake");
    await new Promise((r) => setTimeout(r, 10));
  }
  return server.serverNames;
}

/**
 * A self-signed certificate whose only subjectAltName is the IP address `ip`,
 * trusted when a client configures `ca: fixture.cert`.
 *
 * @param ip - The one IP address the certificate names.
 */
function buildIpOnlyCertFixture(ip: string): { cert: string; key: string } {
  const pems = generate([{ name: "commonName", value: "ip-only.example.com" }], {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip }] }],
  });
  return { cert: pems.cert, key: pems.private };
}

// RSA key generation plus a real handshake per case is CPU-bound, so the budget
// is set here, as in the other TLS suites, rather than through the suite-wide one.
describe("TLS to an IP host: no SNI, identity still checked", { timeout: 60_000 }, () => {
  const servers: TlsServer[] = [];
  const sockets: TLSSocket[] = [];
  const clients: MllpClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    await Promise.all(
      servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))),
    );
    servers.length = 0;
  });

  async function startServer(cert: string, key: string): Promise<RecordingServer> {
    const serverNames: Array<string | false | null> = [];
    const srv = tlsCreateServer({ cert, key }, (socket) => {
      serverNames.push(socket.servername);
      sockets.push(socket);
    });
    // A refused handshake is the point of some cases here; the client's
    // rejection carries the assertion, so the server-side error is ignored.
    srv.on("tlsClientError", () => undefined);
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    return { port: (srv.address() as AddressInfo).port, serverNames };
  }

  function trackClient(c: MllpClient): MllpClient {
    clients.push(c);
    return c;
  }

  it("connects to an IP host without sending it as SNI", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = await startServer(cert, key);

    const client = trackClient(
      createClient({ host: "127.0.0.1", port: server.port, tls: { ca: cert } }),
    );
    await client.connect();

    const names = await handshakes(server, 1);
    expect(names).toHaveLength(1);
    expect(names[0]).toBeFalsy();
  });

  it("still refuses an IP host whose certificate does not name it", async () => {
    // Trusted as its own CA, but its only subjectAltName is wrong.example.com.
    const { cert, key } = buildSanMismatchCertFixture();
    const server = await startServer(cert, key);

    const client = trackClient(
      createClient({ host: "127.0.0.1", port: server.port, tls: { ca: cert } }),
    );
    await expect(client.connect()).rejects.toMatchObject({
      name: "MllpConnectionError",
      connectionCause: "tls-verify",
    });
  });

  it("checks an IP servername that differs from the host against that IP, without SNI", async () => {
    // The certificate names 127.0.0.2 only; the socket goes to 127.0.0.1.
    const { cert, key } = buildIpOnlyCertFixture("127.0.0.2");
    const server = await startServer(cert, key);

    const named = trackClient(
      createClient({
        host: "127.0.0.1",
        port: server.port,
        tls: { ca: cert, servername: "127.0.0.2" },
      }),
    );
    await named.connect();
    const names = await handshakes(server, 1);
    expect(names).toHaveLength(1);
    expect(names[0]).toBeFalsy();

    // Without the servername the target is the host, which the certificate does not name.
    const unnamed = trackClient(
      createClient({ host: "127.0.0.1", port: server.port, tls: { ca: cert } }),
    );
    await expect(unnamed.connect()).rejects.toMatchObject({
      name: "MllpConnectionError",
      connectionCause: "tls-verify",
    });
  });

  it("still sends a host name as SNI", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = await startServer(cert, key);

    const client = trackClient(
      createClient({
        host: "127.0.0.1",
        port: server.port,
        tls: { ca: cert, servername: "localhost" },
      }),
    );
    await client.connect();

    expect(await handshakes(server, 1)).toEqual(["localhost"]);
  });
});
