/**
 * The programs under `examples/` type-check against the source, before anything is built.
 *
 * `pnpm typecheck` used to run `tsc --noEmit -p examples` after the root check. It is now the
 * shared `cosyte-process typecheck`, which runs one `tsc --noEmit` over the root `tsconfig.json`,
 * and that file cannot take the examples in: they import this package by its published name, and
 * mapping that name to the source at the root would also redirect `pnpm examples`, whose tsx run
 * reads the root `tsconfig.json` and must resolve the name through `exports` to the BUILT package.
 * So the examples keep their own `examples/tsconfig.json`, and this case compiles it, inside
 * `pnpm test`, which every required CI run already gates on.
 *
 * Exactly what the old command did: the same config file, every diagnostic it reports, none
 * filtered.
 */

import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONFIG = join(import.meta.dirname, "..", "examples", "tsconfig.json");

function format(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${String(diagnostic.code)} ${message}`;
  }
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${String(line + 1)} TS${String(diagnostic.code)} ${message}`;
}

describe("examples/tsconfig.json", () => {
  // A whole-program check of the examples and the source they map to: seconds, not milliseconds,
  // and slower under the coverage run, so it states its own budget rather than widening the
  // shared ceiling.
  it(
    "type-checks with no diagnostics, as `tsc --noEmit -p examples` did",
    { timeout: 60_000 },
    () => {
      const configErrors: ts.Diagnostic[] = [];
      const parsed = ts.getParsedCommandLineOfConfigFile(
        CONFIG,
        { noEmit: true },
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (d) => configErrors.push(d),
        },
      );
      expect(configErrors.map(format)).toEqual([]);
      if (parsed === undefined) throw new Error(`${CONFIG} could not be read`);
      expect(parsed.errors.map(format)).toEqual([]);
      expect(parsed.fileNames.length).toBeGreaterThan(0);

      const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
      expect(ts.getPreEmitDiagnostics(program).map(format)).toEqual([]);
    },
  );
});
