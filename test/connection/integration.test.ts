import { describe, it, expect } from "vitest";
import { Connection } from "../../src/connection/connection.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";

describe("Connection integration over InMemoryTransport (TRANS-03)", () => {
  it("full send→receive round-trip: client sends, server receives", () => {
    const [clientTransport, serverTransport] = InMemoryTransport.pair();

    const serverMessages: Buffer[] = [];
    const serverConn = new Connection({
      transport: serverTransport,
      onMessage: (payload) => {
        serverMessages.push(payload);
      },
    });

    const clientConn = new Connection({ transport: clientTransport });

    // Simulate connect on both ends
    clientConn.notifyConnect("127.0.0.1", 2575);
    serverConn.notifyConnect("127.0.0.1", 2575);

    // simulateConnect fires the onConnect handler (no-op here, Connection doesn't register onConnect)
    clientTransport.simulateConnect();
    serverTransport.simulateConnect();

    // Client sends an MLLP-framed message
    const payload = Buffer.from("MSH|^~\\&|...");
    const framed = encodeFrame(payload);
    clientConn.send(framed);

    // Server should have received the decoded payload synchronously
    expect(serverMessages).toHaveLength(1);
    expect(serverMessages[0]).toEqual(payload);
  });

  it("bidirectional: server sends ACK back to client", () => {
    const [clientTransport, serverTransport] = InMemoryTransport.pair();

    const clientMessages: Buffer[] = [];
    const serverMessages: Buffer[] = [];

    const clientConn = new Connection({
      transport: clientTransport,
      onMessage: (p) => {
        clientMessages.push(p);
      },
    });

    const serverConn = new Connection({
      transport: serverTransport,
      onMessage: (payload) => {
        serverMessages.push(payload);
        // Server echoes back (simulating ACK)
        serverConn.send(encodeFrame(payload));
      },
    });

    clientConn.notifyConnect("127.0.0.1", 2575);
    serverConn.notifyConnect("127.0.0.1", 2575);

    const payload = Buffer.from("MSH|^~\\&|SENDER|FAC|RECV|FAC|20240101||ADT^A01|123|P|2.5");
    clientConn.send(encodeFrame(payload));

    // Server received original, client received echo, both synchronous
    expect(serverMessages).toHaveLength(1);
    expect(serverMessages[0]).toEqual(payload);
    expect(clientMessages).toHaveLength(1);
    expect(clientMessages[0]).toEqual(payload);
  });

  it("chunked delivery: split(1) produces same frames (TRANS-04)", () => {
    const [clientTransport, serverTransport] = InMemoryTransport.pair();
    serverTransport.split(1); // server receives one byte at a time

    const serverMessages: Buffer[] = [];
    const serverConn = new Connection({
      transport: serverTransport,
      onMessage: (p) => {
        serverMessages.push(p);
      },
    });
    const clientConn = new Connection({ transport: clientTransport });

    clientConn.notifyConnect(null, null);
    serverConn.notifyConnect(null, null);

    const payload = Buffer.from("MSH|ABC");
    clientConn.send(encodeFrame(payload));

    // Despite 1-byte chunking, FrameReader assembles the complete frame
    expect(serverMessages).toHaveLength(1);
    expect(serverMessages[0]).toEqual(payload);
  });

  it("connectionId is consistent across events", () => {
    const [clientTransport] = InMemoryTransport.pair();
    const conn = new Connection({ transport: clientTransport });

    const seenIds = new Set<string>();
    conn.on("stateChange", () => {
      // connectionId is on the Connection itself, not the stateChange payload
      seenIds.add(conn.connectionId);
    });
    conn.on("connect", (e: { connectionId: string }) => {
      seenIds.add(e.connectionId);
    });

    conn.notifyConnect("127.0.0.1", 2575);

    // All events should reference the same connectionId
    for (const id of seenIds) {
      expect(id).toBe(conn.connectionId);
    }
    expect(seenIds.size).toBeGreaterThan(0);
  });

  it("getStats() serializes to JSON with no loss (OBS-04)", () => {
    const [clientTransport] = InMemoryTransport.pair();
    const conn = new Connection({ transport: clientTransport });
    conn.notifyConnect("10.0.0.1", 2575);

    const stats = conn.getStats();
    const serialized = JSON.parse(JSON.stringify(stats)) as typeof stats;

    expect(serialized.state).toBe(stats.state);
    expect(serialized.connectionId).toBe(stats.connectionId);
    expect(serialized.remoteAddress).toBe("10.0.0.1");
    // connectedAt should round-trip as a string (not a Date after JSON.parse)
    expect(typeof serialized.connectedAt).toBe("string");
    expect(serialized.bytesIn).toBe(0);
  });

  it("multiple messages in sequence all delivered in order", () => {
    const [clientTransport, serverTransport] = InMemoryTransport.pair();

    const serverMessages: Buffer[] = [];
    const serverConn = new Connection({
      transport: serverTransport,
      onMessage: (p) => {
        serverMessages.push(p);
      },
    });
    const clientConn = new Connection({ transport: clientTransport });

    clientConn.notifyConnect(null, null);
    serverConn.notifyConnect(null, null);

    const payloads = [
      Buffer.from("MSH|first"),
      Buffer.from("MSH|second"),
      Buffer.from("MSH|third"),
    ];

    for (const p of payloads) {
      clientConn.send(encodeFrame(p));
    }

    expect(serverMessages).toHaveLength(3);
    for (let i = 0; i < payloads.length; i++) {
      expect(serverMessages[i]).toEqual(payloads[i]);
    }
  });

  it("bytesIn/bytesOut tracked correctly in getStats()", () => {
    const [clientTransport, serverTransport] = InMemoryTransport.pair();

    const serverConn = new Connection({ transport: serverTransport });
    const clientConn = new Connection({ transport: clientTransport });

    clientConn.notifyConnect(null, null);
    serverConn.notifyConnect(null, null);

    const payload = Buffer.from("MSH|TEST");
    const framed = encodeFrame(payload);
    clientConn.send(framed);

    expect(clientConn.getStats().bytesOut).toBe(framed.length);
    expect(serverConn.getStats().bytesIn).toBe(framed.length);
  });
});
