import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { TLSSocket } from "node:tls";
import { TlsTransport } from "../../src/transport/tls-transport.js";
import type { Transport } from "../../src/transport/index.js";

/**
 * Minimal `tls.TLSSocket` test double — mirrors `net-transport.test.ts`'s
 * `MockSocket` pattern. Only the surface `TlsTransport` touches is stubbed.
 */
interface MockTlsSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function makeSocket(): MockTlsSocket {
  const ee = new EventEmitter() as MockTlsSocket;
  ee.write = vi.fn().mockReturnValue(true);
  ee.end = vi.fn();
  ee.destroy = vi.fn();
  return ee;
}

describe("TlsTransport", () => {
  let socket: MockTlsSocket;
  let transport: Transport;

  beforeEach(() => {
    socket = makeSocket();
    transport = new TlsTransport(socket as unknown as TLSSocket);
  });

  it("implements Transport interface", () => {
    expect(typeof transport.write).toBe("function");
    expect(typeof transport.close).toBe("function");
    expect(typeof transport.destroy).toBe("function");
    expect(typeof transport.onData).toBe("function");
    expect(typeof transport.onConnect).toBe("function");
    expect(typeof transport.onClose).toBe("function");
    expect(typeof transport.onError).toBe("function");
  });

  it("write() delegates to socket.write()", () => {
    const buf = Buffer.from("hello");
    socket.write.mockReturnValue(false);
    const result = transport.write(buf);
    expect(socket.write).toHaveBeenCalledWith(buf);
    expect(result).toBe(false);
  });

  it("close() calls socket.end()", () => {
    transport.close();
    expect(socket.end).toHaveBeenCalled();
  });

  it("destroy() calls socket.destroy() with reason", () => {
    const err = new Error("test");
    transport.destroy(err);
    expect(socket.destroy).toHaveBeenCalledWith(err);
  });

  it("destroy() calls socket.destroy() without reason", () => {
    transport.destroy();
    expect(socket.destroy).toHaveBeenCalledWith(undefined);
  });

  it("onData() registers data listener on socket", () => {
    const fn = vi.fn();
    transport.onData(fn);
    const chunk = Buffer.from([0x0b]);
    socket.emit("data", chunk);
    expect(fn).toHaveBeenCalledWith(chunk);
  });

  it("onData() replaces previous handler (set-once semantics)", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    transport.onData(fn1);
    transport.onData(fn2);
    socket.emit("data", Buffer.from([0x41]));
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("onConnect() fires on 'secureConnect', NOT on raw TCP 'connect'", () => {
    const fn = vi.fn();
    transport.onConnect(fn);
    socket.emit("connect");
    expect(fn).not.toHaveBeenCalled();
    socket.emit("secureConnect");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("onConnect() replaces previous handler (set-once semantics)", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    transport.onConnect(fn1);
    transport.onConnect(fn2);
    socket.emit("secureConnect");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("onClose() fires when socket emits close", () => {
    const fn = vi.fn();
    transport.onClose(fn);
    socket.emit("close");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("onClose() replaces previous handler (set-once semantics)", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    transport.onClose(fn1);
    transport.onClose(fn2);
    socket.emit("close");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("onError() fires when socket emits error", () => {
    const fn = vi.fn();
    transport.onError(fn);
    const err = new Error("CERT_HAS_EXPIRED");
    socket.emit("error", err);
    expect(fn).toHaveBeenCalledWith(err);
  });

  it("onError() replaces previous handler (set-once semantics)", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    transport.onError(fn1);
    transport.onError(fn2);
    socket.emit("error", new Error("boom"));
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});
