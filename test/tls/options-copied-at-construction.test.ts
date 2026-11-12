/**
 * The TLS options a client or server is given are copied when it is constructed.
 *
 * Both constructors check the options once (`pfx` with `cert` or `key` is refused with
 * `MLLP_TLS_CREDENTIAL_CONFLICT`). A client that kept the caller's object would read it again on
 * every connect and reconnect, so a change made after construction would reach the socket without
 * passing that check. Each case here mutates the object after construction and then connects
 * again: the change must have no effect.
 *
 * Certificates and PKCS#12 files are generated in memory per run; no file and no real identity is
 * involved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";

import { RUNTIME } from "../_helpers/runtime.js";
import { createClient, type ClientOptions, type MllpClient } from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import { buildPfx } from "../helpers/pkcs12-fixtures.js";
import {
  buildMutualTlsFixture,
  buildNamedServerCertFixture,
  buildUntrustedCertFixture,
  type MutualTlsFixture,
  type ServerCertFixture,
} from "../helpers/tls-fixtures.js";

const PASSPHRASE = "synthetic-pfx-passphrase";
const OTHER_CN = "synthetic-other-identity";

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

/** Poll `cond` every 10ms until true or `timeoutMs` elapses (real timers). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A writable view of the options object, as a caller holding a reference could treat it. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

// Node.js only: neither Deno's nor Bun's `node:tls` loads a PKCS#12 file the way Node.js does.
describe.skipIf(RUNTIME !== "node")(
  "TLS options changed after construction",
  { timeout: 60_000 },
  () => {
    const clients: MllpClient[] = [];
    const servers: MllpServer[] = [];
    const rawServers: TlsServer[] = [];

    afterEach(async () => {
      for (const c of clients) c.destroy();
      clients.length = 0;
      for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
      servers.length = 0;
      for (const s of rawServers) {
        s.close();
        s.unref();
      }
      rawServers.length = 0;
    });

    let sharedMutual: MutualTlsFixture | undefined;
    function mutual(): MutualTlsFixture {
      sharedMutual ??= buildMutualTlsFixture();
      return sharedMutual;
    }

    /** A second client identity, trusted by the recording server, carried in a PKCS#12 file. */
    let sharedOther: ServerCertFixture | undefined;
    function other(): ServerCertFixture {
      sharedOther ??= buildNamedServerCertFixture(OTHER_CN);
      return sharedOther;
    }

    /**
     * A TLS server that requires a client certificate, trusts both the test client's and the other
     * identity's, and records the subject CN each client presents. `dropFirst` ends the first session, so a reconnecting client comes
     * back.
     */
    async function recordingServer(): Promise<{
      port: number;
      presented: Array<string | null>;
      dropFirst: () => void;
    }> {
      const { cert, key } = mutual();
      const presented: Array<string | null> = [];
      const sockets: TLSSocket[] = [];
      const raw = tlsCreateServer(
        { cert, key, ca: [cert, other().cert], requestCert: true },
        (socket: TLSSocket) => {
          const subject = socket.getPeerCertificate().subject as { CN?: string } | undefined;
          presented.push(subject?.CN ?? null);
          sockets.push(socket);
        },
      );
      rawServers.push(raw);
      const port = await new Promise<number>((resolve, reject) => {
        raw.once("error", reject);
        raw.listen(0, "127.0.0.1", () => {
          const addr = raw.address();
          if (typeof addr === "object" && addr !== null) resolve(addr.port);
          else reject(new Error("no address"));
        });
      });
      return { port, presented, dropFirst: () => must(sockets[0]).end() };
    }

    it("a pfx added to a client's tls object after construction is not used on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const tls: Writable<NonNullable<Exclude<ClientOptions["tls"], true>>> = {
        ca: cert,
        servername: "localhost",
        cert: clientCert,
        key: clientKey,
      };
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls,
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      // The combination the constructor refuses, made after it ran.
      tls.pfx = buildPfx(other(), PASSPHRASE);
      tls.passphrase = PASSPHRASE;
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("a tls object swapped into a client's options after construction is not used on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const opts: Writable<ClientOptions> = {
        host: "127.0.0.1",
        port,
        tls: { ca: cert, servername: "localhost", cert: clientCert, key: clientKey },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      };
      const client = createClient(opts);
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      opts.tls = {
        ca: cert,
        servername: "localhost",
        cert: clientCert,
        key: clientKey,
        pfx: buildPfx(other(), PASSPHRASE),
        passphrase: PASSPHRASE,
      };
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("a ca array changed after construction does not change what a client trusts", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented } = await recordingServer();
      const ca = [cert];
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: { ca, servername: "localhost", cert: clientCert, key: clientKey },
      });
      clients.push(client);

      ca[0] = buildUntrustedCertFixture().cert;

      await expect(client.connect()).resolves.toBeUndefined();
      expect(client.state).toBe("CONNECTED");
      await waitFor(() => presented.length === 1);
      expect(presented).toEqual(["test-client"]);
    });

    it("a server's clientAuth changed after construction does not change the connection event", async () => {
      const { cert, key, clientCert, clientKey } = mutual();
      const tls: Writable<{ cert: string; key: string; ca: string; clientAuth: "WANT" | "NONE" }> =
        {
          cert,
          key,
          ca: cert,
          clientAuth: "WANT",
        };
      const server = createServer({ tls, autoAck: "AA" });
      servers.push(server);
      const peers: Array<{ subjectCN: string | null } | null> = [];
      server.on("connection", (e: { peerCertificate: { subjectCN: string | null } | null }) => {
        peers.push(e.peerCertificate);
      });
      await server.listen(0, "127.0.0.1");

      tls.clientAuth = "NONE";

      const client = createClient({
        host: "127.0.0.1",
        port: must(server.getStats().port),
        tls: { ca: cert, servername: "localhost", cert: clientCert, key: clientKey },
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => peers.length === 1);
      expect(peers[0]?.subjectCN).toBe("test-client");
    });
  },
);
