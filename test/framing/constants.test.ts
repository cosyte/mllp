import { describe, it, expect } from 'vitest';
import { VT, FS, CR, LF, DEFAULT_MAX_FRAME_SIZE } from '../../src/framing/constants.js';

describe('MLLP constants', () => {
  it('VT is 0x0B', () => {
    expect(VT).toBe(0x0b);
  });
  it('FS is 0x1C', () => {
    expect(FS).toBe(0x1c);
  });
  it('CR is 0x0D', () => {
    expect(CR).toBe(0x0d);
  });
  it('LF is 0x0A', () => {
    expect(LF).toBe(0x0a);
  });
  it('DEFAULT_MAX_FRAME_SIZE is 16 MiB', () => {
    expect(DEFAULT_MAX_FRAME_SIZE).toBe(16 * 1024 * 1024);
  });
});
