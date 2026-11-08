import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The directory of a tool that `@cosyte/process` owns (tsup, prettier and the rest), resolved
 * from that package rather than from this repository.
 *
 * The shared `cosyte-process` bin carries the tool versions every `pnpm build`, `pnpm format` and
 * `pnpm test` run uses, and this repository declares no direct devDependency on them, so a test
 * that needs the tool itself has to reach the same copy the scripts run. Resolving it any other
 * way would test a version no script uses. The lookup walks Node's own search path from that
 * package, since not every tool exports its `package.json`.
 */
export function processToolDir(root: string, tool: string): string {
  // The real path, not pnpm's link to it: Node searches upward from the directory it is handed,
  // and from the link that search would find this repository's own node_modules first.
  const processDir = realpathSync(join(root, "node_modules", "@cosyte", "process"));
  const fromProcess = createRequire(join(processDir, "package.json"));
  for (const dir of fromProcess.resolve.paths(tool) ?? []) {
    const candidate = join(dir, tool);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${tool} does not resolve from @cosyte/process: run pnpm install`);
}
