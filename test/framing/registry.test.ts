import { describe, it, expect } from 'vitest';
import { createWarning, type MllpWarning, type WarningCode } from '../../src/framing/registry.js';

describe('createWarning', () => {
  it('produces frozen objects', () => {
    const w = createWarning('MLLP_FS_WITHOUT_CR', 42, 'test');
    expect(Object.isFrozen(w)).toBe(true);
  });

  it('sets code, byteOffset, message correctly', () => {
    const w = createWarning('MLLP_FS_WITHOUT_CR', 42, 'FS without CR at offset 42');
    expect(w.code).toBe('MLLP_FS_WITHOUT_CR');
    expect(w.byteOffset).toBe(42);
    expect(w.message).toBe('FS without CR at offset 42');
  });

  it('connectionId is undefined at framing layer (D-07)', () => {
    const w = createWarning('MLLP_EMPTY_PAYLOAD', 0, 'msg');
    expect(w.connectionId).toBeUndefined();
  });

  it('timestamp is a Date', () => {
    const w = createWarning('MLLP_TRAILING_BYTES', 10, 'msg');
    expect(w.timestamp).toBeInstanceOf(Date);
  });

  it('mutating a frozen warning throws in strict mode', () => {
    const w = createWarning('MLLP_FRAME_TOO_LARGE', 0, 'msg');
    expect(() => {
      (w as Record<string, unknown>)['code'] = 'MLLP_EMPTY_PAYLOAD';
    }).toThrow();
  });

  it('all 11 codes are valid WarningCode values', () => {
    const codes: WarningCode[] = [
      'MLLP_MISSING_LEADING_VT',
      'MLLP_FS_WITHOUT_CR',
      'MLLP_LF_AFTER_FS',
      'MLLP_LEADING_WHITESPACE',
      'MLLP_TRAILING_BYTES',
      'MLLP_PAYLOAD_CONTAINS_VT',
      'MLLP_PAYLOAD_CONTAINS_FS',
      'MLLP_EMPTY_PAYLOAD',
      'MLLP_FRAME_TOO_LARGE',
      'MLLP_ACK_UNMATCHED_CONTROL_ID',
      'MLLP_ACK_AFTER_TIMEOUT',
    ];
    expect(codes).toHaveLength(11);
    codes.forEach((code) => {
      const w: MllpWarning = createWarning(code, 0, 'test');
      expect(w.code).toBe(code);
    });
  });
});
