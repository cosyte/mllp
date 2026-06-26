import { describe, it, expect, vi, afterEach } from "vitest";
import { Connection } from "../../src/connection/connection.js";
import type { StateChangeEvent } from "../../src/connection/connection.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

describe("Connection close/destroy semantics (LIFE-05)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("close() during CONNECTING", () => {
    it("transitions to CLOSED without leaking timers", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      // Still in CONNECTING (notifyConnect not called)
      await conn.close();
      expect(conn.state).toBe("CLOSED");
    });

    it("does not hang waiting for drain when CONNECTING", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      await expect(
        Promise.race([
          conn.close(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
        ]),
      ).resolves.toBeUndefined();
    });

    it("emits stateChange CONNECTING → CLOSED", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      const changes: { from: string; to: string }[] = [];
      conn.on("stateChange", (e: StateChangeEvent) => changes.push(e));
      await conn.close();
      expect(changes.some((c) => c.from === "CONNECTING" && c.to === "CLOSED")).toBe(true);
    });
  });

  describe("close() during CONNECTED → DRAINING → DISCONNECTED", () => {
    it("transitions CONNECTED → DRAINING → DISCONNECTED on normal close", async () => {
      const [clientT, serverT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect("127.0.0.1", 2575);
      expect(conn.state).toBe("CONNECTED");

      const states: string[] = [];
      conn.on("stateChange", (e: StateChangeEvent) => states.push(e.to));

      await conn.close();
      expect(states).toContain("DRAINING");
      expect(states).toContain("DISCONNECTED");
      expect(conn.state).toBe("DISCONNECTED");
      void serverT; // suppress unused warning
    });

    it("reaches DISCONNECTED state after close", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      await conn.close();
      expect(conn.state).toBe("DISCONNECTED");
    });

    it("close() is a no-op when already DISCONNECTED", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      await conn.close();
      expect(conn.state).toBe("DISCONNECTED");
      // Second close() should be a no-op
      await expect(conn.close()).resolves.toBeUndefined();
      expect(conn.state).toBe("DISCONNECTED");
    });
  });

  describe("close() drain timeout (LIFE-05)", () => {
    it("transitions to CLOSED when drain timeout elapses", async () => {
      vi.useFakeTimers();
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT, drainTimeoutMs: 100 });
      conn.notifyConnect(null, null);

      // Override beforeClose to never resolve (simulate hung drain)
      conn.beforeClose = () =>
        new Promise<void>(() => {
          /* never resolves */
        });

      const closePromise = conn.close({ drainTimeoutMs: 100 });
      await vi.runAllTimersAsync();
      await closePromise;

      expect(conn.state).toBe("CLOSED");
    });

    it("emits stateChange DRAINING → CLOSED on timeout", async () => {
      vi.useFakeTimers();
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      conn.beforeClose = () =>
        new Promise<void>(() => {
          /* never resolves */
        });

      const changes: { from: string; to: string }[] = [];
      conn.on("stateChange", (e: StateChangeEvent) => changes.push(e));

      const closePromise = conn.close({ drainTimeoutMs: 50 });
      await vi.runAllTimersAsync();
      await closePromise;

      expect(changes.some((c) => c.from === "DRAINING" && c.to === "CLOSED")).toBe(true);
    });

    it("emits close event on timeout", async () => {
      vi.useFakeTimers();
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      conn.beforeClose = () =>
        new Promise<void>(() => {
          /* never resolves */
        });

      let closeFired = false;
      conn.on("close", () => {
        closeFired = true;
      });

      const closePromise = conn.close({ drainTimeoutMs: 50 });
      await vi.runAllTimersAsync();
      await closePromise;

      expect(closeFired).toBe(true);
    });
  });

  describe("RECONNECTING state transitions (WR-01, WR-02, WR-03 coverage)", () => {
    it("close() during RECONNECTING transitions to CLOSED", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      // Force to RECONNECTING via internal _transition (CONNECTING → RECONNECTING is legal)
      (conn as unknown as { _transition: (s: string, r?: string) => void })._transition(
        "RECONNECTING",
        "test setup",
      );
      expect(conn.state).toBe("RECONNECTING");

      await conn.close();
      expect(conn.state).toBe("CLOSED");
    });

    it("transport close during RECONNECTING transitions to CLOSED (WR-01)", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      (conn as unknown as { _transition: (s: string, r?: string) => void })._transition(
        "RECONNECTING",
        "test setup",
      );

      let closeFired = false;
      conn.on("close", () => {
        closeFired = true;
      });

      // Simulate peer close by destroying clientT (triggers onClose callback)
      clientT.destroy();
      expect(conn.state).toBe("CLOSED");
      expect(closeFired).toBe(true);
    });

    it("transport error during RECONNECTING transitions to CLOSED with phase=reconnect (WR-02)", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      (conn as unknown as { _transition: (s: string, r?: string) => void })._transition(
        "RECONNECTING",
        "test setup",
      );

      let errorPayload: { error: { phase?: string } } | undefined;
      conn.on("error", (e: unknown) => {
        errorPayload = e as { error: { phase?: string } };
      });

      clientT.destroy(new Error("simulated reconnect error"));
      expect(conn.state).toBe("CLOSED");
      expect(errorPayload?.error?.phase).toBe("reconnect");
    });

    it("second close() during DRAINING joins first drain — beforeClose called once (WR-03)", async () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);

      let beforeCloseCallCount = 0;
      conn.beforeClose = () => {
        beforeCloseCallCount++;
        return new Promise<void>((resolve) => setTimeout(resolve, 50));
      };

      // Fire two concurrent close() calls
      const p1 = conn.close();
      const p2 = conn.close(); // must join p1, not call beforeClose again
      await Promise.all([p1, p2]);

      expect(beforeCloseCallCount).toBe(1);
      expect(conn.state).toBe("DISCONNECTED");
    });
  });

  describe("destroy()", () => {
    it("transitions CONNECTING → CLOSED directly", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.destroy(new Error("aborted"));
      expect(conn.state).toBe("CLOSED");
    });

    it("transitions CONNECTED → CLOSED directly (not through DRAINING)", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      const states: string[] = [];
      conn.on("stateChange", (e: StateChangeEvent) => states.push(e.to));
      conn.destroy();
      expect(states).not.toContain("DRAINING");
      expect(conn.state).toBe("CLOSED");
    });

    it("transitions DRAINING → CLOSED directly", () => {
      vi.useFakeTimers();
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.notifyConnect(null, null);
      conn.beforeClose = () =>
        new Promise<void>(() => {
          /* never resolves */
        });

      void conn.close({ drainTimeoutMs: 5000 }); // fire and forget — hangs in DRAINING
      expect(conn.state).toBe("DRAINING");
      conn.destroy(); // interrupt drain
      expect(conn.state).toBe("CLOSED");
      vi.clearAllTimers();
    });

    it("is idempotent after CLOSED", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      conn.destroy();
      expect(() => {
        conn.destroy();
      }).not.toThrow();
      expect(conn.state).toBe("CLOSED");
    });

    it("emits close event with connectionId", () => {
      const [clientT] = InMemoryTransport.pair();
      const conn = new Connection({ transport: clientT });
      const ids: string[] = [];
      conn.on("close", (e: { connectionId: string }) => {
        ids.push(e.connectionId);
      });
      conn.destroy();
      expect(ids).toHaveLength(1);
      expect(ids[0]).toBe(conn.connectionId);
    });
  });
});
