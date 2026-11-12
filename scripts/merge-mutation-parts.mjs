#!/usr/bin/env node
// Merge the parts of the pull request mutation job into the one changed-files report the mutation
// ratchet reads (reports/mutation/changed.json), and refuse when they do not add up to one whole
// run: a part missing, a file in one part and not another, a file no change touched, or a mutant
// tested by no part or by two (scripts/mutation-shards.mjs says how a part takes its share).
//
//   node scripts/merge-mutation-parts.mjs --parts <n> --dir <dir> --base <ref> [--out <file>]
//
// Each part's report is read from <dir>/mutation-part-<k>-of-<n>/changed.json, where the job's
// artifact download puts it. The files are checked against the source files the change touched,
// read from git the way `cosyte-mutate changed` reads them. Exit 0 merged, 1 the parts do not add
// up, 2 the inputs could not be read.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readChanges } from "@cosyte/script-utils/changes";
import { loadConfig, selectChangedFiles } from "@cosyte/vitest-config/mutate";

import { MAX_PARTS, ShardMergeError, mergeShardReports } from "./mutation-shards.mjs";

/**
 * @param {string[]} argv The arguments.
 * @returns {{ parts: number, dir: string, base: string, out: string }} The options.
 */
function parseArgs(argv) {
  const options = { parts: 0, dir: "", base: "", out: "reports/mutation/changed.json" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--parts") options.parts = Number(value);
    else if (flag === "--dir") options.dir = value;
    else if (flag === "--base") options.base = value;
    else if (flag === "--out") options.out = value;
    else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
  }
  if (!Number.isInteger(options.parts) || options.parts < 1 || options.parts > MAX_PARTS) {
    throw new Error(`--parts must be a whole number from 1 to ${MAX_PARTS}`);
  }
  if (options.dir === "" || options.base === "") throw new Error("--dir and --base are required");
  return options;
}

/**
 * @param {string[]} argv The arguments.
 * @returns {Promise<number>} The exit code.
 */
async function main(argv) {
  const cwd = process.cwd();
  let options;
  const reports = [];
  let expected;
  try {
    options = parseArgs(argv);
    for (let k = 1; k <= options.parts; k += 1) {
      const path = join(options.dir, `mutation-part-${k}-of-${options.parts}`, "changed.json");
      if (!existsSync(path))
        throw new Error(`part ${k} of ${options.parts} left no report at ${path}`);
      reports.push(JSON.parse(readFileSync(path, "utf8")));
    }
    const config = await loadConfig(resolve(cwd, "stryker.config.mjs"));
    const change = readChanges({ base: options.base, cwd });
    expected = selectChangedFiles({
      changed: change.files.keys(),
      root: change.root,
      cwd,
      patterns: config.mutate,
    });
  } catch (error) {
    process.stderr.write(`merge-mutation-parts: could not read the parts: ${error.message}\n`);
    return 2;
  }

  let merged;
  try {
    merged = mergeShardReports(reports, { projectRoot: cwd });
    const stray = merged.summary.files.filter((file) => !expected.includes(file));
    if (stray.length > 0) {
      throw new ShardMergeError(
        `the parts mutated ${JSON.stringify(stray)}, which the change against ${options.base} did not touch`,
      );
    }
  } catch (error) {
    if (!(error instanceof ShardMergeError)) throw error;
    process.stderr.write(
      `merge-mutation-parts: the parts do not add up to one run: ${error.message}\n`,
    );
    return 1;
  }

  const out = resolve(cwd, options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(merged.report)}\n`);

  const { files, mutants, tested, ignored, removed } = merged.summary;
  const none = expected.filter((file) => !files.includes(file));
  const lines = [
    `Source files the change touched: ${expected.length === 0 ? "none" : expected.join(", ")}`,
    `Mutated in every one of the ${options.parts} parts: ${files.length === 0 ? "none" : files.join(", ")}`,
    ...(none.length > 0 ? [`With no mutant in them: ${none.join(", ")}`] : []),
    `Mutants: ${mutants}, each owned by exactly one part (${tested
      .map((count, i) => `part ${i + 1}: ${count}`)
      .join(", ")}), and ${ignored} ignored by a comment in every part`,
    `Emptied calls StrykerJS removed in their own part, as a single run removes them: ${removed}`,
    `Merged report: ${options.out}`,
  ];
  const text = `${lines.join("\n")}\n`;
  process.stdout.write(text);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") {
    appendFileSync(summary, `### Mutation parts merged\n\n\`\`\`text\n${text}\`\`\`\n`);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
