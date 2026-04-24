import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('sanity', () => {
  it('package exports VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('Node.js version is 20+', () => {
    const major = parseInt(process.version.slice(1).split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
