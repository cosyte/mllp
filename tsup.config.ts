import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
    'ack-from-hl7/index': 'src/ack-from-hl7/index.ts',
  },
  format: ['esm', 'cjs'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,      // D-10: external .map files in dist/
  dts: true,            // D-11: tsup-bundled .d.ts + .d.cts per entry
  // experimental-dts is EXCLUDED per D-12: documented broken for multi-entry (egoist/tsup#1046)
  clean: true,          // D-13: delete stale dist/ before each build
  external: ['@cosyte/hl7'],  // SETUP-03: peer dep never bundled
  splitting: false,     // Keeps each subpath self-contained; no shared chunk
  treeshake: true,
  outDir: 'dist',
});
