// Mutant shards: one changed-files mutation run split across parallel CI jobs, each testing a part
// of the mutants, and the parts merged back into one report.
//
// WHY. The pull request mutation job mutates every source file a change touched, whole. A change to
// both src/client/client.ts and src/server/server.ts took close to the job's 60 minute limit on one
// runner. Splitting by file cannot help a change to one large file, so the split is by mutant.
//
// HOW A PART KNOWS ITS SHARE. Every part runs the same `cosyte-mutate changed` over the same files,
// with MLLP_MUTANT_SHARD=<k>/<n> set. stryker.config.mjs then adds the ignorer below, which gives
// each top-level piece of a file (a statement of the module, or a member of a top-level class) to
// exactly one part, and marks every mutant of a piece another part owns as ignored with a reason
// that names that part. Each part's report therefore lists every mutant of every file: the ones it
// tested, and the ones it left to the part named in the reason. A mutant is decided inside the
// piece it sits in, so StrykerJS generates the same mutants, with the same ids, in every part.
//
// THE MERGE. `mergeShardReports` takes the n part reports and builds the report a single run would
// have written: for each mutant, the entry of the one part that tested it. It refuses, rather than
// merges, when a part is missing, the parts name different files or different code, a mutant was
// tested by two parts, or a mutant was tested by none. No mutant is left out to save time: a
// mutant every part ignored for the shard is a failure, never a skipped mutant.
//
// The only mutants a part's report holds that the merged report leaves out are the CallExpression
// mutants StrykerJS itself removes in the part that owns them (its rule keeps an emptied call only
// when nothing inside the call has a mutant of its own); a single run removes the same ones.

/** The variable a part reads its share from: `<k>/<n>`. */
export const SHARD_VARIABLE = "MLLP_MUTANT_SHARD";

/** The variable `cosyte-mutate full` shards files by; never set together with ours. */
export const FILE_SHARD_VARIABLE = "COSYTE_MUTATE_SHARD";

/** The ignorer's name in the StrykerJS config. */
export const IGNORER_NAME = "mllp-mutant-shard";

/** The most parts a run may be split into. */
export const MAX_PARTS = 16;

const REASON = /^Mutant shard: tested in part (\d+) of (\d+)$/;

/**
 * The reason a part gives for a mutant another part tests.
 *
 * @param {number} part The part that tests it.
 * @param {number} n The number of parts.
 * @returns {string} The reason.
 */
export function shardReason(part, n) {
  return `Mutant shard: tested in part ${part} of ${n}`;
}

/**
 * Read a part from the value of {@link SHARD_VARIABLE}.
 *
 * @param {string | undefined} value `<k>/<n>`, two whole numbers with 1 <= k <= n <= 16.
 * @returns {{ k: number, n: number } | null} The part, or null when the value is unset or empty.
 */
export function parseShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const k = match === null ? 0 : Number(match[1]);
  const n = match === null ? 0 : Number(match[2]);
  if (k < 1 || k > n || n > MAX_PARTS) {
    throw new Error(
      `${SHARD_VARIABLE} must be <k>/<n>, two whole numbers with 1 <= k <= n <= ${MAX_PARTS}, not ${JSON.stringify(value)}`,
    );
  }
  return { k, n };
}

/**
 * The StrykerJS config with the mutant shard ignorer added when {@link SHARD_VARIABLE} is set, and
 * the config unchanged when it is not. The files mutated, the thresholds and every other option
 * stay as they are.
 *
 * @param {Record<string, any>} config The StrykerJS config.
 * @param {Record<string, string | undefined>} env Where the variable is read.
 * @param {string} pluginPath This module's absolute path, the plugin StrykerJS loads.
 * @returns {Record<string, any>} The config to run.
 */
export function withMutantShards(config, env, pluginPath) {
  const shard = parseShard(env[SHARD_VARIABLE]);
  if (shard === null) return config;
  const fileShard = env[FILE_SHARD_VARIABLE];
  if (fileShard !== undefined && fileShard !== "") {
    throw new Error(
      `${SHARD_VARIABLE} and ${FILE_SHARD_VARIABLE} are both set; a run is split by mutant or by file, never both`,
    );
  }
  return {
    ...config,
    plugins: [...(config.plugins ?? []), pluginPath],
    ignorers: [...(config.ignorers ?? []), IGNORER_NAME],
  };
}

// THE PIECES OF A FILE. A node is open when it is the module itself, or a top-level class (with the
// `export` around it, when there is one) or that class's body. Every child of an open node that is
// not open itself is a piece. No StrykerJS mutator makes a mutant on an open node, so every mutant
// sits inside exactly one piece.

const SKIPPED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

/**
 * The AST nodes directly under a node, in source order of their keys.
 *
 * @param {any} node An AST node.
 * @returns {any[]} Its child nodes.
 */
function childNodes(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * @param {unknown} value A value.
 * @returns {boolean} Whether it is an AST node.
 */
function isNode(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string";
}

/**
 * Whether a node is open, given whether its parent is.
 *
 * @param {any} node The node.
 * @param {boolean} parentOpen Whether its parent is open; true is passed for the module itself.
 * @returns {boolean} Whether it is open.
 */
function isOpen(node, parentOpen) {
  if (node.type === "Program") return true;
  if (!parentOpen) return false;
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    return node.declaration?.type === "ClassDeclaration";
  }
  return node.type === "ClassDeclaration" || node.type === "ClassBody";
}

/**
 * How much testing a piece is likely to cost: its nodes, without type annotations and imports,
 * which carry no mutant.
 *
 * @param {any} node The piece.
 * @returns {number} Its weight.
 */
function weightOf(node) {
  if (node.type.startsWith("TS") || node.type === "ImportDeclaration") return 0;
  let weight = 1;
  for (const child of childNodes(node)) weight += weightOf(child);
  return weight;
}

/**
 * A piece's key: its type and its offsets in the file, which every part reads the same way.
 *
 * @param {any} node The piece.
 * @returns {string} The key.
 */
function keyOf(node) {
  return `${node.type}:${node.start}:${node.end}`;
}

/**
 * The pieces of a file, in source order.
 *
 * @param {any} program The file's Program node.
 * @returns {any[]} Its pieces.
 */
export function piecesOf(program) {
  const pieces = [];
  const walk = (node) => {
    for (const child of childNodes(node)) {
      if (isOpen(child, true)) walk(child);
      else pieces.push(child);
    }
  };
  walk(program);
  return pieces;
}

/**
 * Give each piece of a file to one of n parts, the heaviest first, each to the part with the least
 * weight so far (the lowest numbered on a tie). Every part reads the same file, so every part
 * reaches the same plan.
 *
 * @param {any} program The file's Program node.
 * @param {number} n The number of parts.
 * @returns {Map<string, number>} Piece key to its part, 1 to n.
 */
export function planParts(program, n) {
  const pieces = piecesOf(program).map((node, order) => ({
    key: keyOf(node),
    weight: weightOf(node),
    order,
  }));
  pieces.sort((a, b) => b.weight - a.weight || a.order - b.order);
  const loads = Array.from({ length: n }, () => 0);
  const plan = new Map();
  for (const piece of pieces) {
    let part = 0;
    for (let i = 1; i < n; i += 1) if (loads[i] < loads[part]) part = i;
    loads[part] += piece.weight;
    plan.set(piece.key, part + 1);
  }
  return plan;
}

/**
 * Whether the node at a path is open, read up its ancestors.
 *
 * @param {any} path A Babel NodePath.
 * @returns {boolean} Whether it is open.
 */
function pathIsOpen(path) {
  if (path.node.type === "Program") return true;
  const parent = path.parentPath;
  if (parent === null || parent === undefined) return false;
  if (!isOpen(path.node, true)) return false;
  return pathIsOpen(parent);
}

/**
 * The ignorer for one part: it ignores each piece another part owns, with a reason naming that
 * part, and nothing else.
 *
 * @param {{ k: number, n: number }} shard The part.
 * @returns {{ shouldIgnore(path: any): string | undefined }} The ignorer.
 */
export function createShardIgnorer({ k, n }) {
  /** @type {WeakMap<object, Map<string, number>>} */
  const plans = new WeakMap();
  return {
    shouldIgnore(path) {
      const parent = path.parentPath;
      if (parent === null || parent === undefined) return undefined;
      if (!pathIsOpen(parent) || isOpen(path.node, true)) return undefined;
      let program = parent;
      while (program.node.type !== "Program") program = program.parentPath;
      let plan = plans.get(program.node);
      if (plan === undefined) {
        plan = planParts(program.node, n);
        plans.set(program.node, plan);
      }
      const part = plan.get(keyOf(path.node));
      if (part === undefined) {
        throw new Error(
          `mutant shard: a ${path.node.type} at offset ${path.node.start} is no piece of the plan, so no part would own its mutants`,
        );
      }
      return part === k ? undefined : shardReason(part, n);
    },
  };
}

/** The ignorer StrykerJS loads: the part comes from {@link SHARD_VARIABLE} when it first runs. */
const envIgnorer = {
  /** @type {{ shouldIgnore(path: any): string | undefined } | null} */
  inner: null,
  shouldIgnore(path) {
    if (this.inner === null) {
      const shard = parseShard(process.env[SHARD_VARIABLE]);
      if (shard === null) {
        throw new Error(`the ${IGNORER_NAME} ignorer runs only with ${SHARD_VARIABLE} set`);
      }
      this.inner = createShardIgnorer(shard);
    }
    return this.inner.shouldIgnore(path);
  },
};

/** The StrykerJS plugins this module declares: `{ kind, name, value }`, as `declareValuePlugin` builds. */
export const strykerPlugins = [{ kind: "Ignore", name: IGNORER_NAME, value: envIgnorer }];

/** Thrown when the part reports cannot be merged into one honest report. */
export class ShardMergeError extends Error {
  /**
   * @param {string} message What is wrong.
   */
  constructor(message) {
    super(message);
    this.name = "ShardMergeError";
  }
}

/**
 * The part a mutant entry was left to, or null when this part tested it.
 *
 * @param {any} mutant A mutant entry of a part's report.
 * @param {number} n The number of parts.
 * @returns {number | null} The part named in its reason.
 */
function leftTo(mutant, n) {
  if (mutant.status !== "Ignored") return null;
  const match = REASON.exec(String(mutant.statusReason ?? ""));
  if (match === null) return null;
  if (Number(match[2]) !== n) {
    throw new ShardMergeError(
      `mutant ${mutant.id} was left to part ${match[1]} of ${match[2]}, in a run of ${n} parts`,
    );
  }
  return Number(match[1]);
}

/**
 * The same mutant, as two parts read it.
 *
 * @param {any} a A mutant entry.
 * @param {any} b A mutant entry.
 * @returns {boolean} Whether they name the same mutation.
 */
function sameMutation(a, b) {
  return (
    a.mutatorName === b.mutatorName &&
    a.replacement === b.replacement &&
    JSON.stringify(a.location) === JSON.stringify(b.location)
  );
}

/**
 * Merge the reports of the n parts of one run into the report a single run would have written.
 *
 * @param {any[]} reports The part reports, part 1 first.
 * @param {object} [options] Options.
 * @param {string} [options.projectRoot] The project root the merged report names.
 * @returns {{ report: any, summary: { files: string[], mutants: number, tested: number[], ignored: number, removed: number } }}
 *   The merged report; its mutants; how many each part owned; how many every part listed as
 *   ignored before the split; and how many emptied calls their own part removed.
 */
export function mergeShardReports(reports, { projectRoot } = {}) {
  const n = reports.length;
  if (n < 1 || n > MAX_PARTS) {
    throw new ShardMergeError(`a run has 1 to ${MAX_PARTS} parts, not ${n}`);
  }
  reports.forEach((report, i) => {
    if (typeof report?.files !== "object" || report.files === null) {
      throw new ShardMergeError(`the report of part ${i + 1} has no files`);
    }
  });
  const files = Object.keys(reports[0].files).sort();
  reports.forEach((report, i) => {
    const own = Object.keys(report.files).sort();
    if (JSON.stringify(own) !== JSON.stringify(files)) {
      throw new ShardMergeError(
        `part ${i + 1} mutated ${JSON.stringify(own)}, but part 1 mutated ${JSON.stringify(files)}: every part must mutate the same files`,
      );
    }
  });

  // Test ids are each part's own, so when the reports carry tests, each id is prefixed with its
  // part, in the tests and in the mutants that name them.
  const prefixed = reports.some((r) => r.testFiles !== undefined);
  const tested = Array.from({ length: n }, () => 0);
  let removed = 0;
  let ignored = 0;
  let total = 0;
  const mergedFiles = {};
  for (const file of files) {
    const first = reports[0].files[file];
    /** @type {Map<string, any[]>} mutant id to its entry in each part (undefined where absent) */
    const byId = new Map();
    reports.forEach((report, i) => {
      const entry = report.files[file];
      if (entry.source !== first.source) {
        throw new ShardMergeError(`part ${i + 1} read different source for ${file} than part 1`);
      }
      for (const mutant of entry.mutants ?? []) {
        const id = String(mutant.id);
        let row = byId.get(id);
        if (row === undefined) {
          row = Array.from({ length: n }, () => undefined);
          byId.set(id, row);
        }
        if (row[i] !== undefined) {
          throw new ShardMergeError(`part ${i + 1} lists mutant ${id} of ${file} twice`);
        }
        row[i] = mutant;
      }
    });

    const kept = [];
    for (const [id, row] of byId) {
      const present = row.filter((m) => m !== undefined);
      for (const m of present) {
        if (!sameMutation(m, present[0])) {
          throw new ShardMergeError(
            `the parts read mutant ${id} of ${file} as different mutations`,
          );
        }
      }
      const owners = [];
      const named = new Set();
      row.forEach((m, i) => {
        if (m === undefined) return;
        const to = leftTo(m, n);
        if (to === null) owners.push(i + 1);
        else named.add(to);
      });
      // A mutant a comment or an excluded mutator ignores is ignored before the split, so every
      // part lists it the same way and none tests it, as a single run does not.
      if (
        named.size === 0 &&
        present.length === n &&
        present.every((m) => m.status === "Ignored" && m.statusReason === present[0].statusReason)
      ) {
        ignored += 1;
        total += 1;
        kept.push({ mutant: present[0], part: 1 });
        continue;
      }
      if (owners.length > 1) {
        throw new ShardMergeError(
          `mutant ${id} of ${file} was tested by parts ${owners.join(" and ")}; each mutant belongs to one part`,
        );
      }
      if (named.size > 1) {
        throw new ShardMergeError(
          `mutant ${id} of ${file} was left to parts ${[...named].join(" and ")}; each mutant belongs to one part`,
        );
      }
      const owner = owners[0] ?? [...named][0];
      if (owners.length === 1 && named.size === 1 && !named.has(owner)) {
        throw new ShardMergeError(
          `mutant ${id} of ${file} was tested by part ${owner} but left to part ${[...named][0]}`,
        );
      }
      row.forEach((m, i) => {
        if (m === undefined && i + 1 !== owner) {
          throw new ShardMergeError(
            `part ${i + 1} has no mutant ${id} of ${file}, which it should list as left to part ${owner}`,
          );
        }
      });
      if (owners.length === 1) {
        tested[owner - 1] += 1;
        total += 1;
        kept.push({ mutant: row[owner - 1], part: owner });
        continue;
      }
      // No part tested it. The one honest case: the part that owns it never generated it, because
      // StrykerJS removed an emptied call there that holds mutants of its own, as a single run does.
      if (row[owner - 1] === undefined && present[0].mutatorName === "CallExpression") {
        removed += 1;
        continue;
      }
      throw new ShardMergeError(
        `mutant ${id} of ${file} (${present[0].mutatorName}) was tested by no part: every part that lists it left it to part ${owner}`,
      );
    }
    kept.sort((a, b) => Number(a.mutant.id) - Number(b.mutant.id));
    mergedFiles[file] = {
      ...first,
      mutants: kept.map((k) => withPart(k.mutant, k.part, prefixed)),
    };
  }

  const report = { ...reports[0], files: mergedFiles };
  if (projectRoot !== undefined) report.projectRoot = projectRoot;
  if (prefixed) {
    const testFiles = {};
    reports.forEach((r, i) => {
      for (const [name, entry] of Object.entries(r.testFiles ?? {})) {
        const into = (testFiles[name] ??= { ...entry, tests: [] });
        for (const test of entry.tests ?? []) {
          into.tests.push({ ...test, id: testId(i + 1, test.id) });
        }
      }
    });
    report.testFiles = testFiles;
  }
  return { report, summary: { files, mutants: total, tested, ignored, removed } };
}

/**
 * A test id as the merged report names it.
 *
 * @param {number} part The part whose run named the test.
 * @param {unknown} id The id in that run.
 * @returns {string} The merged id.
 */
function testId(part, id) {
  return `part-${part}/${String(id)}`;
}

/**
 * A mutant entry with the test ids it names prefixed with its part, when the reports carry tests.
 *
 * @param {any} mutant The entry from the part that tested it.
 * @param {number} part That part.
 * @param {boolean} prefixed Whether test ids are prefixed.
 * @returns {any} The entry for the merged report.
 */
function withPart(mutant, part, prefixed) {
  if (!prefixed) return mutant;
  const out = { ...mutant };
  if (Array.isArray(mutant.coveredBy)) out.coveredBy = mutant.coveredBy.map((t) => testId(part, t));
  if (Array.isArray(mutant.killedBy)) out.killedBy = mutant.killedBy.map((t) => testId(part, t));
  return out;
}
