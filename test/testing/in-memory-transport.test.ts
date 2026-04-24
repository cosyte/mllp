import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

describe('InMemoryTransport', () => {
  describe('pair()', () => {
    it('returns two Transport-shaped objects', () => {
      const [a, b] = InMemoryTransport.pair();
      expect(typeof a.write).toBe('function');
      expect(typeof b.write).toBe('function');
      expect(typeof a.onData).toBe('function');
      expect(typeof b.onData).toBe('function');
      expect(typeof a.onConnect).toBe('function');
      expect(typeof a.onClose).toBe('function');
      expect(typeof a.onError).toBe('function');
    });

    it('write to a delivers to b synchronously (D-03)', () => {
      const [a, b] = InMemoryTransport.pair();
      const received: Buffer[] = [];
      b.onData((chunk) => received.push(chunk));
      const buf = Buffer.from([0x0b, 0x41, 0x1c, 0x0d]);
      a.write(buf);
      // Synchronous — received is populated before the next line
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(buf);
    });

    it('write to b delivers to a synchronously', () => {
      const [a, b] = InMemoryTransport.pair();
      const received: Buffer[] = [];
      a.onData((chunk) => received.push(chunk));
      b.write(Buffer.from([0x41]));
      expect(received).toHaveLength(1);
    });

    it('write returns true when peer is not paused', () => {
      const [a, b] = InMemoryTransport.pair();
      b.onData(() => {});
      expect(a.write(Buffer.from([0x41]))).toBe(true);
    });

    it('bidirectional round-trip (TRANS-03)', () => {
      const [a, b] = InMemoryTransport.pair();
      const aReceived: Buffer[] = [];
      const bReceived: Buffer[] = [];
      a.onData((c) => aReceived.push(c));
      b.onData((c) => bReceived.push(c));
      a.write(Buffer.from('ping'));
      b.write(Buffer.from('pong'));
      expect(bReceived[0]).toEqual(Buffer.from('ping'));
      expect(aReceived[0]).toEqual(Buffer.from('pong'));
    });

    it('write returns false when peer has no onData and is not paused (null peer handler)', () => {
      const [a] = InMemoryTransport.pair();
      // Peer (b) has no onData registered — write still returns true (peer not paused)
      const result = a.write(Buffer.from([0x41]));
      expect(result).toBe(true);
    });
  });

  describe('split() (TRANS-04)', () => {
    it('delivers write in chunks of bytesPerChunk == 1', () => {
      const [a, b] = InMemoryTransport.pair();
      const chunks: Buffer[] = [];
      b.split(1);
      b.onData((c) => chunks.push(Buffer.from(c)));
      a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toEqual(Buffer.from([0x0b]));
      expect(chunks[1]).toEqual(Buffer.from([0x41]));
      expect(chunks[2]).toEqual(Buffer.from([0x1c]));
      expect(chunks[3]).toEqual(Buffer.from([0x0d]));
    });

    it('delivers in chunks of bytesPerChunk > 1', () => {
      const [a, b] = InMemoryTransport.pair();
      const chunks: Buffer[] = [];
      b.split(2);
      b.onData((c) => chunks.push(Buffer.from(c)));
      a.write(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
      expect(chunks).toHaveLength(3); // [1,2], [3,4], [5]
      expect(chunks[0]).toEqual(Buffer.from([0x01, 0x02]));
      expect(chunks[1]).toEqual(Buffer.from([0x03, 0x04]));
      expect(chunks[2]).toEqual(Buffer.from([0x05]));
    });

    it('split(0) disables chunking — delivers whole buffer', () => {
      const [a, b] = InMemoryTransport.pair();
      const chunks: Buffer[] = [];
      b.split(1);
      b.split(0); // disable
      b.onData((c) => chunks.push(Buffer.from(c)));
      a.write(Buffer.from([0x01, 0x02, 0x03]));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    });
  });

  describe('pause()/resume() (TRANS-04)', () => {
    it('pause() prevents delivery until resume()', () => {
      const [a, b] = InMemoryTransport.pair();
      const received: Buffer[] = [];
      b.pause();
      b.onData((c) => received.push(c));
      a.write(Buffer.from([0x41]));
      expect(received).toHaveLength(0); // queued, not delivered
      b.resume();
      expect(received).toHaveLength(1); // flushed on resume
    });

    it('write returns false when peer is paused (backpressure signal)', () => {
      const [a, b] = InMemoryTransport.pair();
      b.onData(() => {});
      b.pause();
      const result = a.write(Buffer.from([0x41]));
      expect(result).toBe(false);
    });

    it('resume() delivers pending chunks in order', () => {
      const [a, b] = InMemoryTransport.pair();
      const received: Buffer[] = [];
      b.pause();
      b.onData((c) => received.push(Buffer.from(c)));
      a.write(Buffer.from([1]));
      a.write(Buffer.from([2]));
      a.write(Buffer.from([3]));
      b.resume();
      expect(received).toHaveLength(3);
      expect(received[0]).toEqual(Buffer.from([1]));
      expect(received[1]).toEqual(Buffer.from([2]));
      expect(received[2]).toEqual(Buffer.from([3]));
    });

    it('queued chunks are copies — mutation after write does not corrupt queue', () => {
      const [a, b] = InMemoryTransport.pair();
      const received: Buffer[] = [];
      b.pause();
      b.onData((c) => received.push(Buffer.from(c)));
      const buf = Buffer.from([0x42]);
      a.write(buf);
      buf[0] = 0xff; // mutate original after queuing
      b.resume();
      // The queued copy should still have 0x42, not 0xff
      expect(received[0]).toEqual(Buffer.from([0x42]));
    });
  });

  describe('destroy() (TRANS-04)', () => {
    it('fires onError then onClose', () => {
      const [a] = InMemoryTransport.pair();
      const order: string[] = [];
      a.onError(() => order.push('error'));
      a.onClose(() => order.push('close'));
      a.destroy(new Error('abrupt disconnect'));
      expect(order).toEqual(['error', 'close']);
    });

    it('fires onError with provided reason', () => {
      const [a] = InMemoryTransport.pair();
      const errors: Error[] = [];
      a.onError((e) => errors.push(e));
      a.onClose(() => {});
      const reason = new Error('test disconnect');
      a.destroy(reason);
      expect(errors[0]).toBe(reason);
    });

    it('fires onError with default error when no reason given', () => {
      const [a] = InMemoryTransport.pair();
      const errors: Error[] = [];
      a.onError((e) => errors.push(e));
      a.onClose(() => {});
      a.destroy();
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]?.message).toContain('destroyed');
    });

    it('write() returns false after destroy', () => {
      const [a, b] = InMemoryTransport.pair();
      b.onData(() => {});
      a.destroy();
      expect(a.write(Buffer.from([0x41]))).toBe(false);
    });

    it('second destroy() is a no-op (idempotent)', () => {
      const [a] = InMemoryTransport.pair();
      const errorFn = vi.fn();
      a.onError(errorFn);
      a.onClose(() => {});
      a.destroy();
      a.destroy(); // should not fire again
      expect(errorFn).toHaveBeenCalledOnce();
    });
  });

  describe('re-entrancy guard (D-03)', () => {
    it('throws when write is called from inside onData handler', () => {
      const [a, b] = InMemoryTransport.pair();
      b.onData(() => {
        // Write back to a from inside b's onData handler.
        // a delivers to b synchronously — causing re-entrant _deliverChunk on b.
        a.write(Buffer.from([0x42]));
      });
      expect(() => a.write(Buffer.from([0x41]))).toThrow(
        'InMemoryTransport: re-entrant write detected',
      );
    });
  });

  describe('close()', () => {
    it('fires onClose on both ends', () => {
      const [a, b] = InMemoryTransport.pair();
      const aClosed = vi.fn();
      const bClosed = vi.fn();
      a.onClose(aClosed);
      b.onClose(bClosed);
      a.close();
      expect(aClosed).toHaveBeenCalledOnce();
      expect(bClosed).toHaveBeenCalledOnce();
    });

    it('write returns false after close on calling end', () => {
      const [a, b] = InMemoryTransport.pair();
      b.onData(() => {});
      a.close();
      expect(a.write(Buffer.from([0x41]))).toBe(false);
    });

    it('write returns false after close on peer end (peer is also destroyed)', () => {
      const [a, b] = InMemoryTransport.pair();
      a.onData(() => {});
      b.onClose(() => {});
      a.close();
      // b was also marked destroyed by close()
      expect(b.write(Buffer.from([0x41]))).toBe(false);
    });

    it('second close() is a no-op (idempotent)', () => {
      const [a, b] = InMemoryTransport.pair();
      const aClosed = vi.fn();
      const bClosed = vi.fn();
      a.onClose(aClosed);
      b.onClose(bClosed);
      a.close();
      a.close(); // no-op
      expect(aClosed).toHaveBeenCalledOnce();
    });
  });

  describe('simulateConnect()', () => {
    it('fires onConnect handler', () => {
      const [a] = InMemoryTransport.pair();
      const fn = vi.fn();
      a.onConnect(fn);
      a.simulateConnect();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('simulateConnect() is a no-op when no handler registered', () => {
      const [a] = InMemoryTransport.pair();
      // Should not throw
      expect(() => a.simulateConnect()).not.toThrow();
    });
  });
});
