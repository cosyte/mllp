/**
 * MllpTimeoutError tests (PLAN-02, ERR-02).
 *
 * Verifies the error class shape: readonly fields, name discrimination,
 * Error.captureStackTrace discipline, and instanceof correctness.
 */

import { describe, it, expect } from 'vitest';
import { MllpTimeoutError } from '../../src/client/error.js';

describe('MllpTimeoutError (PLAN-02 / ERR-02)', () => {
  it('Test 1: constructs with all fields readable as readonly', () => {
    const err = new MllpTimeoutError('ack timeout', {
      messageControlId: 'MSG00001',
      elapsedMs: 30_000,
      sentAt: 1234567890,
    });
    expect(err.message).toBe('ack timeout');
    expect(err.messageControlId).toBe('MSG00001');
    expect(err.elapsedMs).toBe(30_000);
    expect(err.sentAt).toBe(1234567890);
  });

  it('Test 2: name is "MllpTimeoutError" and instanceof checks pass', () => {
    const err = new MllpTimeoutError('ack timeout', {
      messageControlId: 'MSG00002',
      elapsedMs: 100,
      sentAt: 1,
    });
    expect(err.name).toBe('MllpTimeoutError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MllpTimeoutError);
  });

  it('Test 3: messageControlId accepts undefined (FIFO mode)', () => {
    const err = new MllpTimeoutError('ack timeout (fifo)', {
      messageControlId: undefined,
      elapsedMs: 50,
      sentAt: 100,
    });
    expect(err.messageControlId).toBeUndefined();
    expect(err.elapsedMs).toBe(50);
  });

  it('Test 4: stack trace excludes the constructor frame', () => {
    const err = new MllpTimeoutError('ack timeout', {
      messageControlId: 'MSG-X',
      elapsedMs: 10,
      sentAt: 0,
    });
    // The error's own constructor frame should be filtered out by
    // Error.captureStackTrace(this, MllpTimeoutError). The first frame
    // captured should be the call site (this test), not the constructor.
    expect(err.stack).toBeDefined();
    expect(err.stack).not.toMatch(/at new MllpTimeoutError/);
  });

  it('Test 5: all PLAN-XX-fills sentinels removed (PLAN-02 / PLAN-04 / PLAN-05 all filled)', async () => {
    // Read the file directly to assert sentinel hygiene at the source level.
    const fs = await import('node:fs/promises');
    const url = new URL('../../src/client/error.ts', import.meta.url);
    const text = await fs.readFile(url, 'utf8');
    expect(text).not.toMatch(/PLAN-02 fills/);
    expect(text).not.toMatch(/PLAN-04 fills/);
    // PLAN-05 sentinel removed once PLAN-05 fills MllpBackpressureError.
    expect(text).not.toMatch(/PLAN-05 fills/);
  });
});
