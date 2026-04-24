import { describe, it, expect } from 'vitest';
import { MllpConnectionError, type ConnectionErrorPhase } from '../../src/connection/error.js';

describe('MllpConnectionError', () => {
  it('is an instance of Error', () => {
    const err = new MllpConnectionError('refused', {
      cause: new Error('ECONNREFUSED'),
      phase: 'connect',
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('has name MllpConnectionError', () => {
    const err = new MllpConnectionError('refused', {
      cause: new Error('x'),
      phase: 'connect',
    });
    expect(err.name).toBe('MllpConnectionError');
  });

  it('carries cause and phase', () => {
    const cause = new Error('ECONNRESET');
    const err = new MllpConnectionError('reset during send', {
      cause,
      phase: 'send',
    });
    expect(err.cause).toBe(cause);
    expect(err.phase).toBe('send');
    expect(err.message).toBe('reset during send');
  });

  it('supports all 5 phase values', () => {
    const phases: ConnectionErrorPhase[] = ['connect', 'send', 'receive', 'close', 'reconnect'];
    for (const phase of phases) {
      const err = new MllpConnectionError('test', { cause: new Error('x'), phase });
      expect(err.phase).toBe(phase);
    }
  });

  it('cause is the original error object', () => {
    const original = new Error('DNS failure');
    const err = new MllpConnectionError('connect failed', {
      cause: original,
      phase: 'connect',
    });
    expect(err.cause).toBe(original);
  });
});
