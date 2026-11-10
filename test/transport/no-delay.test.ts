/**
 * Client and server sockets send each write at once: Nagle's algorithm is off on both.
 *
 * MLLP is request and response: a sender writes a frame and waits for its ACK. With Nagle's
 * algorithm on, a small write that follows another still unacknowledged waits for that ACK, and
 * with the peer's delayed ACK the two wait on each other. On a 127.0.0.1 socket with 64 messages
 * in flight, turning it off raised throughput and cut the 99th percentile latency by an order of
 * magnitude. These watch `setNoDelay` on every socket the client opens and the server accepts,
 * over 127.0.0.1 only. Every message is synthetic.
 */

import { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../../src/client/client.js";
import { createServer } from "../../src/server/server.js";
import { must } from "../helpers/tracked-servers.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

const MESSAGE = Buffer.from(
  "MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260101120000||ADT^A01|NODELAY1|P|2.5\rPID|1\r",
  "latin1",
);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every socket `setNoDelay` is called on, with what it is given, read once the calls are made. */
function watchNoDelay(): () => { socket: Socket; enable: boolean | undefined }[] {
  const spy = vi.spyOn(Socket.prototype, "setNoDelay");
  return () =>
    spy.mock.calls.map((args, k) => ({
      socket: spy.mock.contexts[k] as Socket,
      enable: args[0],
    }));
}

describe("Nagle's algorithm is off on every MLLP socket", () => {
  it("on a plaintext client and the socket its server accepts", async () => {
    const seen = watchNoDelay();
    const server = createServer({ autoAck: "AA" });
    await server.listen(0, "127.0.0.1");
    const client = createClient({ host: "127.0.0.1", port: must(server.getStats().port) });
    try {
      await client.connect();
      await client.send(MESSAGE);
      const calls = seen();
      const on = calls.filter((c) => c.enable === true);
      // One for the client's socket, one for the server's.
      expect(new Set(on.map((c) => c.socket)).size).toBeGreaterThanOrEqual(2);
      expect(calls.every((c) => c.enable === true)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("on a TLS client and the socket its server accepts", async () => {
    const seen = watchNoDelay();
    const fixture = buildServerCertFixture();
    const server = createServer({
      autoAck: "AA",
      tls: { cert: fixture.cert, key: fixture.key },
    });
    await server.listen(0, "127.0.0.1");
    const client = createClient({
      host: "127.0.0.1",
      port: must(server.getStats().port),
      tls: { ca: fixture.cert },
    });
    try {
      await client.connect();
      await client.send(MESSAGE);
      const calls = seen();
      const on = calls.filter((c) => c.enable === true);
      expect(new Set(on.map((c) => c.socket)).size).toBeGreaterThanOrEqual(2);
      expect(calls.every((c) => c.enable === true)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
