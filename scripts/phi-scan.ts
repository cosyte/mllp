#!/usr/bin/env tsx
/**
 * `@cosyte/mllp` PHI scanner, the CI / pre-commit half of the PHI commit-gate.
 *
 * Pure Node. Zero runtime deps. Walks the synthetic HL7/MLLP fixtures AND test
 * sources under `test/` (plus a conservative text pass over `src/`) and REFUSES
 * anything that looks like real PHI, so a developer cannot commit a real-looking
 * fixture by accident.
 *
 * mllp is a TRANSPORT / framing library: it wraps HL7 v2 messages in MLLP frames
 * (`VT 0x0B + payload + FS 0x1C + CR 0x0D`). Its data fixtures are therefore
 * MLLP-framed HL7 v2 messages (the `.frame.bin` fixtures), and HL7 v2 carries PHI by
 * design (patient names, dates of birth, SSNs, MRNs / account numbers,
 * addresses, phones / emails, and free-text observations). The PHI shapes inside
 * a framed message are IDENTICAL to `@cosyte/hl7`'s, so this scanner is a direct
 * port of hl7's segment/field-position-aware detector, with ONE transport-layer
 * addition: it **unwraps the MLLP frame** (strips the `VT` start-block and the
 * trailing `FS CR` end-block) BEFORE the HL7-aware scan, so the framing bytes
 * cannot defeat delimiter/segment detection. A framed fixture's HL7 payload gets
 * exactly the scan an un-framed `.hl7` file would (see `unwrapMllpFrame`).
 *
 * A framed binary fixture is byte-strict at the front (the VT start-block, then
 * the `MSH` / batch `FHS` / `BHS` segment), so an inline `# synthetic: true`
 * header is impossible, it would break every framing test. This is the same
 * constraint DICOM hits with binary `.dcm` files and X12 with `.edi`, and we
 * solve it the same proven way: a **synthetic allow-list**
 * (`scripts/phi-allow-list.txt`) is the positive declaration that a fixture's
 * identifiers are fake. Any realistic-PHI-shaped token not covered by the
 * allow-list is a hit. Adding a new synthetic fixture therefore means either
 * reusing known-synthetic tokens or consciously extending the allow-list, a
 * reviewed act, never silent.
 *
 * Detection is HL7-shape-aware, NOT a blind text regex: the scanner parses each
 * message's delimiters (from `MSH-1` / `MSH-2`), splits segments → fields →
 * repetitions → components, and inspects only the fields that actually carry
 * each PHI category. That is deliberate, a naive `Family^Given` text scan trips
 * on coded values like `CBC^Complete Blood Count^LN` or `Boston^MA`, giving
 * false confidence. See `phi-scan-overrides.md` for the category → field map and
 * the documented limitations.
 *
 * A non-HL7 binary fixture (a byte/buffer fixture that is not a framed HL7
 * message) is handled safely: it never matches the fixture-like + segment-line
 * gate, so it falls through to the conservative shape pass (dashed-SSN + email)
 * no crash (exit 2), no false positive from binary noise.
 *
 * ---------------------------------------------------------------------------
 * ▶ A `.ts` SOURCE UNDER `test/` IS SCANNED, AND THE FILE IS NOT THE DOCUMENT.
 *
 * `test/` was walked in full, but every `.ts` file under it was then dropped by
 * the read filter, so a tracked test source was scanned by NEITHER route. That
 * is not a corner of the corpus here: measured on `3daf2e9`, `test/` tracked 72
 * `.ts` files, 3 `.frame.bin` and 1 `.md`, so the exclusion removed 72 of 76
 * tracked files and left the gate standing on three fixtures. Twelve of the 72
 * carried inline `PID|` literals. This is an HL7 TRANSPORT package, so an HL7
 * message written straight into a test source is its most common fixture shape,
 * not an exotic one.
 *
 * THE REMEDY IS TWO-SIDED AND EITHER HALF ALONE IS WORTH NOTHING:
 *
 *   - ENUMERATION. The blanket `.ts` exclusion is replaced by an explicit
 *     per-path exemption (`DELIBERATE_VIOLATOR_SOURCES`), because an extension
 *     cannot tell a file that carries violator literals ON PURPOSE from one that
 *     carries them BY ACCIDENT;
 *   - RECOGNITION. Every detector below assumes THE FILE IS THE DOCUMENT and
 *     works line-by-line from a segment id at the START of a line. In a `.ts`
 *     source the line starts with `const` or with a quote, so widening the
 *     enumeration on its own would still have found nothing but the conservative
 *     SSN/email floor. Measured on `3daf2e9`: a probe file carrying a full
 *     `PID` in a string literal exited 0 "OK, no hits" even when NAMED
 *     EXPLICITLY on argv, which bypasses the enumeration entirely, while the
 *     IDENTICAL payload written to a `.hl7` file reported all five fields.
 *     `extractEmbeddedHl7` is the other half.
 * ---------------------------------------------------------------------------
 *
 * SECURITY: every subprocess is `git`, invoked via `execFileSync` with array
 * args only. Never shell-form spawn.
 *
 * ENUMERATION: `all` mode lists `test/` + `src/` first and reads each file
 * afterwards, so a file created and removed inside that window makes a read
 * throw `ENOENT` and would refuse a scan the walk could not complete. The
 * REFUSAL was never the problem, the ENUMERATION was, so exactly one case is
 * tolerated, documented on `Target.tolerateVanish`: a file the walk enumerated
 * ITSELF, that git does not track, failing with `ENOENT`. It is reported on
 * stderr as skipped, never silently. Everything else still refuses.
 *
 * Modes:
 *   --staged                 - scan only files staged in `git diff --cached`
 *   --allow-fixture <path>   - RECORD, then REFUSE: withdraw one already-enumerated
 *                              path from the READ, which makes the run incomplete
 *                              and exits 2. Rejected outright unless logged in
 *                              phi-scan-overrides.md. See THE COMPLETENESS RULE.
 *   <path> [<path>...]       - scan specific paths
 *   (no args)                - scan all in-scope working-tree files
 *
 * Exit codes: 0 (clean), 1 (hits found), 2 (the scan cannot account for
 * something). DERIVED HERE, NEVER PORTED: the siblings deliberately do not agree
 * on these numbers, and this file's own history is why 1 is reserved (see the
 * process-level guard at the bottom).
 *
 * ---------------------------------------------------------------------------
 * ▶ THE COMPLETENESS RULE: A TARGET THIS RUN ENUMERATED AND NEVER READ REFUSES
 * (exit 2), IN EVERY MODE, NAMING THE PATHS.
 *
 * THE DEFECT IT CLOSES, MEASURED AGAINST THIS FILE rather than inherited as a
 * story. `cosyte/config`'s drift probe runs this scanner over a throwaway repo
 * holding one violator and one clean decoy and invokes it as
 * `phi-scan <violator> <decoy> --allow-fixture <decoy>`. Both paths are
 * ENUMERATED; the decoy is then withdrawn by a LOGGED bypass. Measured on
 * `fd04f57`, this scanner reported only its HITS code (1), which means the very
 * same argv over a corpus whose ONLY violator is the withdrawn file reported
 * `OK, no hits` and exit 0. The withdrawal happened at enumeration time
 * (`targets.filter((t) => !allowed.has(t.path))`), so by the time anything
 * counted, a file that was READ AND FOUND CLEAN and a file that was NEVER OPENED
 * were the same state.
 *
 * A SCAN THAT DID NOT OPEN A FILE HAS NO CLEAN VERDICT TO GIVE ABOUT IT, so the
 * only true thing left to say is that the scan is incomplete.
 *
 * THE COMPARISON IS A SET DIFFERENCE, NEVER A SIZE. Counting reads against
 * targets and comparing two numbers is a strictly weaker test, because a count
 * counts the targets that DID get read: a plausible-looking total hides exactly
 * the paths that did not. The refusal names the paths because no number can.
 * This is the same lesson the per-root observation guard below already carries,
 * arriving a second time by a different route.
 *
 * ENUMERATION IS THIS RUN'S OWN DECLARATION OF WHAT IT WILL READ, so the read
 * filters upstream of it are not violations of the rule and are not weakened by
 * it: a `.md` file neither sweeping route admits, a gitignored entry, and a
 * staged path outside `isUnderScanRoot` never became targets and are not in the
 * set. What the rule catches is a path that BECAME a target and then did not get
 * opened.
 *
 * ▶ "IN EVERY MODE" IS A STATEMENT ABOUT THE RULE, NOT A CLAIM THAT EVERY MODE
 * CAN REACH IT TODAY, and the difference is written down because this lineage
 * keeps paying for prose that outran the code. The check is NOT mode-gated (the
 * per-root guard below is, and that is the contrast), but the only live way to
 * withdraw a target is `--allow-fixture`, and a bypass always resolves to
 * `paths` or `--staged`: with `--staged` absent the union below puts it in the
 * positional set, which selects `paths`. So `all` mode's `allowed` set is empty
 * in every argv, and the skip in its read loop is a guard rather than a route.
 * DO NOT DELETE THAT SKIP AS DEAD CODE: it is what keeps the two loops agreeing
 * on what a withdrawal means if the mode rule is ever revisited.
 *
 * A BYPASS NAMING A PATH THIS RUN DOES NOT ENUMERATE ALSO REFUSES, and it is a
 * DIFFERENT claim kept alongside rather than a restatement: that flag subtracts
 * nothing, so honouring it silently lets a developer believe a file was
 * acknowledged when the run never had it in scope. Before this slice such a flag
 * was a silent no-op in every mode.
 *
 * TWO ARGV SHAPES CHANGED, AND BOTH WERE FALSE-GREEN ROUTES:
 *   - `phi-scan <clean> --allow-fixture <violator>` never ADMITTED the violator
 *     rather than withdrawing it, because the seed read
 *     `paths.length > 0 ? paths : [...allowFixtures]`: the flag seeded the target
 *     list ONLY when no positional path was given and was a silent no-op the
 *     moment one was. It reported on `<clean>` alone and exited 0. The seed is
 *     now an UNCONDITIONAL UNION, deduped by repo-relative path, so the flag
 *     means the same thing in every argv;
 *   - `phi-scan <violator> --allow-fixture <violator>` (and the lone-flag form)
 *     withdrew the run's entire target list and reported the empty result clean.
 *
 * WHAT THIS COSTS, STATED RATHER THAN LEFT TO BE DISCOVERED: `--allow-fixture`
 * CAN NO LONGER REACH EXIT 0 IN ANY MODE. The flag, the override log and the
 * rejection gate are all kept, so an attempt is RECORDED AND REFUSED rather than
 * silently honoured. THE HIT FOOTER THEREFORE NO LONGER ADVERTISES
 * `--allow-fixture` AS A REMEDY: a printed remedy that leads to exit 2 is the
 * same defect as one that leads to a false green, with the sign flipped.
 *
 * ▶ AND "THE ALLOW-LIST IS THE ONLY REMEDY" IS AN OVERCLAIM THIS FILE MUST NOT
 * MAKE. `scripts/phi-allow-list.txt` reaches a clean run only for a value one of
 * its five tags covers (`NAME`, `DOB`, `ADDR`, `ID`, `EMAILDOMAIN`). TWO
 * DETECTOR CLASSES HAVE NO TAG AT ALL, keyed on a CONVENTION instead:
 * `checkPhoneField` takes no allow-list parameter and is satisfied only by the
 * `555` fake-exchange convention, and the dashed-SSN branch of
 * `scanCommonShapes` pushes unconditionally, so nothing declares it away. FOR
 * THOSE TWO, `--allow-fixture` WAS THE ONLY AUDITED REMEDY AND THIS RULE REMOVES
 * IT: the fixture bytes have to change. That is a real cost, it is disclosed in
 * the footer where a developer meets it, and giving either class an allow-list
 * tag is a detector-semantics decision with its own argument, not a side effect
 * of this one. Do not restore the flat sentence.
 *
 * ITS ONE EXCEPTION IS THE TOLERATED-VANISH CLASS, and no other. That class is
 * already bounded hard (self-enumerated + untracked + `ENOENT`), announced on
 * stderr, and re-checked after the sweep, so a file that came back is not
 * tolerated, it is a refusal. It is the one case where "enumerated and never
 * read" has a true answer other than "the scan is incomplete": the file is gone,
 * and a run may say so. The exception is passed in as the set of targets that
 * ACTUALLY vanished, never inferred from what was allowed to vanish.
 *
 * A HIT IS NEVER SWALLOWED BY THIS REFUSAL. The three end-of-run refusals (an
 * emptied walk root, an unenumerated bypass, an unread target) are ACCUMULATED
 * and printed together AFTER the hits, so a run that is both incomplete and
 * carrying hits prints everything once. The code is 2: an incomplete sweep is
 * not a verdict, whatever it found on the way. THAT IS A GUARANTEE ABOUT THOSE
 * THREE AND NOT ABOUT REFUSALS IN GENERAL, and the leftovers are named here
 * rather than left to be inferred, BECAUSE THE TWO READ LOOPS DO NOT AGREE AND
 * "ALIGNING" THEM WOULD DELETE A DELIBERATE CALL:
 *   - the WORKING-TREE loop's catch (a target whose bytes cannot be read)
 *     discards the hits found before it. Pre-existing, loud rather than green,
 *     and left alone deliberately: re-ordering to salvage a partial hit list
 *     would be a claim about a corpus the scan just said it could not account
 *     for;
 *   - the INDEX loop's catch, and the refusal raised while BUILDING the index
 *     targets, both call `reportHits` first, because the walk may already have
 *     found PHI under a root that yielded perfectly well;
 *   - the came-back-vanish refusal discards them too, and that one is NOT
 *     disclosed anywhere else. It is pre-existing and this slice does not change
 *     it.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * AN IN-SCOPE ENTRY THAT IS NOT A REGULAR FILE REFUSES THE SCAN (exit 2). It is
 * never silently skipped, because both enumerating routes were blind to it in a
 * way that read as clean. Measured on `d854e81` with a synthetic name-bearing
 * payload kept outside both walk roots:
 *
 *   - the walk enumerates `Dirent.isFile()`, an lstat answer, so a symbolic
 *     link is neither a file nor a directory and fell out of the loop whatever
 *     it pointed at. `isDirectory()` is an lstat answer too, so a LINKED
 *     DIRECTORY took its whole subtree with it, silently;
 *   - `--staged` read content with `git show :<path>`, and git stores a symbolic
 *     link as its TARGET PATH under mode `120000`, so that route was handed the
 *     path text and never the target's bytes. That route is this repo's
 *     pre-commit gate.
 *
 * A link to that payload under `test/` scanned CLEAN on both (exit 0, "OK, no
 * hits"), and so did a link to its DIRECTORY, while naming the target
 * explicitly exited 1 with every hit. The payload was always detectable; the
 * two routes never looked at it.
 *
 * Neither route follows a link it finds INSIDE a scan root: following would read
 * bytes the enumeration does not control (outside the repo, a loop, a device, a
 * FIFO that blocks the gate forever), and git does not carry those bytes anyway,
 * so a hit on them would be a claim about something no commit contains. Refusing
 * states the only true thing available: there is an entry here the scan cannot
 * account for, so the scan is not clean.
 *
 * ▶ THE ROOT ITSELF IS THE EXCEPTION, AND WRITING "NEITHER ROUTE FOLLOWS A LINK"
 * FLAT WAS FALSE. `walk()` opens `TEST_ROOT` / `SRC_ROOT` with `existsSync` +
 * `readdirSync`, and both FOLLOW, so replacing `test/` or `src/` itself with a
 * link to a directory outside the repo makes the walk read straight through it.
 * PRE-EXISTING. The precise reading, which is NOT "its PHI is reported": the
 * tree beyond the link is scanned exactly as the root it replaced would have
 * been, WITH THAT ROOT'S OWN LIMITS. So a fixture-like payload behind a linked
 * `test/` is reported (measured, exit 1), while the same payload behind a linked
 * `src/` gets only the conservative pass and can read clean, exactly as it would
 * through a real `src/`. It is link-NEUTRAL, which is why it is disclosed here
 * instead of closed: refusing a linked root is a different decision about repo
 * layout, not this defect. Do not restore the flat claim, and do not upgrade
 * this one into a promise that a linked root is always caught.
 *
 * "In scope" is each route's own existing ROOT, not a new boundary: the walk
 * still excludes a gitignored entry (the same rule that already excludes a
 * gitignored file, so links do not get a second, stricter boundary of their
 * own), and `--staged` still only looks under `test/` and `src/`. What is NOT
 * carried over to a non-regular entry is the `.ts` / `.md` NAME exemptions.
 * Those are judgements about a file whose bytes the route could have read (a
 * test `.ts` source carries deliberate violator literals, a `.md` is
 * documentation), and a link's name is no evidence at all about what is on the
 * other side. Dropping them also keeps the two routes agreeing on what they
 * refuse. This narrows what those roots ADMIT; it does not widen the roots.
 *
 * A refusal names the entry's own repo-relative path and an engine-owned token
 * for its kind. IT NEVER REPORTS THE LINK TARGET, which is text off the working
 * tree and can itself carry PHI: a target path of the shape
 * `../captures/<surname>-<given>-<dob>.hl7` is the whole reason. The shape is
 * written out rather than an example, because a diagnostic ABOUT a PHI leak is
 * itself a PHI surface, and that applies to the prose explaining it too.
 *
 * ▶ THREE MORE WAYS AN IN-SCOPE ENTRY REACHED NEITHER ROUTE, ALL MEASURED ON
 * `2252d33` BEFORE ANYTHING WAS TOUCHED, AND THE FIRST TWO ARE AT PRE-COMMIT:
 *
 *   - RENAME AND COPY RECORDS WERE NOT ENUMERATED AT ALL. `R`/`C` carry two
 *     paths and `--diff-filter=AMT` deletes them, so `git mv <link> test/<name>`
 *     staged as `R100` at mode `120000` and `--staged` exited 0 over it, and a
 *     rename that also substituted a real name staged as a scored rename and exited 0
 *     over live PID-5 / PID-7 / PID-3. `--no-renames` closes both: the
 *     destination arrives as an ordinary single-path `A`, the source as a `D`
 *     the filter drops. The enumeration is a strict SUPERSET of the previous
 *     one and no record shape changed;
 *   - A REGULAR BLOB STAGED AT EXACTLY `test` OR `src` was in scope for the
 *     REFUSAL above and out of scope for the READ, so nothing looked at it:
 *     exit 0 over the same live values. Both roots' read predicates now admit
 *     the root's own path, and `test` earns the structured scan, because an
 *     entry that REPLACES a root is judged with that root's own limits;
 *   - A WALK ROOT THAT IS NOT A DIRECTORY threw `ENOTDIR` out of `readdirSync`
 *     uncaught, and an uncaught throw exits **1**, the code this contract
 *     reserves for "hits found". A false finding is not the same failure as a
 *     crash and is worse than one, because it is actionable-looking. A dangling
 *     link at a root was the silent half of the same shape: `existsSync`
 *     follows, so the walk returned and the sweep reported OK over the entire
 *     corpus that root stands for. Both refuse now (exit 2); see `walkRoot`.
 *
 * The gitlink (mode `160000`) arm is NOT a hole this closes, and saying so would
 * be false here: `--staged`'s scope already reaches a staged submodule under
 * BOTH roots, and `git show :<path>` on one fails with `bad object`, so the base
 * commit already refused it. What changes is the diagnostic, from an incidental
 * read failure to a named kind. The `.gitignore` note about orphan agent-worktree
 * gitlinks is why the arm is worth keeping legible.
 * ---------------------------------------------------------------------------
 */

import { readFileSync, statSync, lstatSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const ALLOW_LIST_PATH = join(REPO_ROOT, "scripts", "phi-allow-list.txt");
const OVERRIDE_LOG_PATH = join(REPO_ROOT, "phi-scan-overrides.md");

// Roots walked in "all" mode. From `test/` we take EVERY data file except `.ts`
// sources (see `isScannableTestFile`); each is then dispatched by `looksLikeHl7`
// to the structured HL7 scan or the conservative pass. `src/` gets a conservative
// dashed-SSN + email text pass, it is hand-written code, and its JSDoc
// `@example` HL7 snippets carry synthetic names/MRNs that must not trip the
// segment-aware detectors. A committed real SSN/email in code is caught there.
const TEST_ROOT = join(REPO_ROOT, "test");
const SRC_ROOT = join(REPO_ROOT, "src");

// Sources whose `.ts` bytes are a DELIBERATE VIOLATOR CORPUS: they carry
// realistic-PHI-shaped literals on purpose, because they are the positive half
// of this scanner's own tests, and sweeping them would red the gate forever.
//
// THIS IS AN EXPLICIT PATH LIST AND MUST STAY ONE. It replaces a blanket
// `.ts` exclusion that took 72 of the 76 tracked files under `test/` out of
// every route (measured on `3daf2e9`; the remaining corpus was three
// `.frame.bin` files). An extension rule cannot tell a file that carries
// violator literals ON PURPOSE from one that carries them BY ACCIDENT, which is
// the whole distinction this gate exists to make, so the exemption is per-path
// and adding to it is a reviewed act, exactly like adding an allow-list token.
//
// THE EXEMPTION IS TOTAL, not just the structured half, and that is measured
// rather than assumed: this suite's positive tests also assert that the
// CONSERVATIVE pass fires, so they hold a deliberate non-test-domain email (an
// `OBX-5` free-text case) that the shape pass reports on sight. Keeping the
// floor here would red the gate on the one file whose job is to carry violators.
// Allow-listing that value instead is REFUSED and must stay refused: an
// `EMAILDOMAIN` entry is global, so it would switch the email detector off for
// the whole corpus to green one file.
//
// THE RESIDUAL, stated rather than hidden: a real SSN or email committed into
// this ONE path is not reported by this gate. It is bounded by the path list
// being explicit and short, by the file being the scanner's own suite (which is
// read by anyone changing the scanner), and by the value still having to survive
// review. Widening the list is what would make it unbounded, which is why the
// list is per-path and not an extension rule.
const DELIBERATE_VIOLATOR_SOURCES: ReadonlySet<string> = new Set([
  // The scanner's own suite. Every positive test here asserts that a REAL-shaped
  // name / DOB / MRN / address IS reported, so the literals must stay unallowed.
  "test/scripts/phi-scan.test.ts",
]);

// Which `test/` files get swept: EVERY file under `test/` except `.md` docs.
// `.ts` SOURCES ARE INCLUDED HERE, and `scanTarget` then dispatches them to the
// embedded-HL7 recogniser rather than to the file-is-the-document scan (see
// `extractEmbeddedHl7`). The deliberate-violator exemption is NOT applied by
// this predicate: it is applied at the scan, so an exempt file is still
// enumerated and still counts as OBSERVED for the per-root guard.
// Everything else (a framed `.frame.bin`, a bare `.hl7`, a `.txt` / `.json` /
// extensionless live-adapter capture, a byte/buffer fixture) is KEPT and then
// dispatched by `looksLikeHl7`: an HL7 payload (framed or not) gets the full
// structured scan, a non-HL7 blob gets the conservative dashed-SSN + email pass.
// ▶ THIS FILTER MUST NEVER RESTRICT TO A FIXED EXTENSION ALLOW-LIST. Restricting
// silently dropped `.txt` / extensionless captures from any scan at all (the
// directory `test/differential/fixtures/README.md` tells developers to drop real
// captures into), which is precisely the false negative this gate exists to stop.
// ▶ AND IT MUST NOT GO BACK TO EXCLUDING `.ts`. An earlier revision of this
// comment said the filter "must EXCLUDE .ts", which was the rule until
// `PHI-SCAN-WALK-ROOT-SCOPE` measured what it cost: 72 of the 76 tracked files
// under `test/` scanned by NEITHER route, 12 of them carrying inline `PID|`.
// An EXTENSION cannot tell a file that carries violator literals on purpose from
// one that carries them by accident; only the per-path list above can.
// The ROOT'S OWN PATH is admitted as well as the prefix, and it is the one entry
// this filter used to drop while `isUnderScanRoot` below already claimed it. An
// index entry at exactly `test` is never a directory (git records none), so it is
// the corpus root REPLACED by a blob: in scope for the refusal, out of scope for
// the read, and therefore scanned by nothing. Measured on `2252d33`, `--staged`
// exited 0 "OK, no hits" over a staged mode-100644 `test` carrying live PID-5 /
// PID-7 / PID-3 values that the same bytes report under any other name.
function isScannableTestFile(relPath: string): boolean {
  return (relPath === "test" || relPath.startsWith("test/")) && !relPath.endsWith(".md");
}

/** The `src/` half of the same rule, root's own path included for the same reason. */
function isScannableSrcFile(relPath: string): boolean {
  return (relPath === "src" || relPath.startsWith("src/")) && !relPath.endsWith(".md");
}

// The two scan ROOTS. This is the boundary a NON-REGULAR entry is judged against
// on both routes: the extension rules above and in `buildTargetsForStaged` are
// judgements about bytes the route could have read, and a link's name says
// nothing about the other side. See the banner.
//
// The ROOT'S OWN NAME is matched as well as the prefix, and that is not
// symmetry for its own sake: a prefix test alone lets a staged entry named
// exactly `test` or `src` through, which is the one path that REPLACES a walk
// root rather than sitting inside it.
function isUnderScanRoot(relPath: string): boolean {
  return (
    relPath === "test" ||
    relPath === "src" ||
    relPath.startsWith("test/") ||
    relPath.startsWith("src/")
  );
}

// Person-name fields keyed by segment id. XPN fields carry family in component 1
// (`Doe^John`); XCN fields carry an id in component 1 and the family/given in
// components 2/3 (`ATTEND^Smith^Jane`). The distinction is load-bearing, read
// the wrong components and every provider name slips through.
const XPN_NAME_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [5, 6, 9], // patient name / mother's maiden name / alias
  NK1: [2, 30], // next-of-kin name / contact person name
  GT1: [3], // guarantor name
  IN1: [16], // insured's name
  MRG: [7], // prior patient name
  STF: [3], // staff name
};
const XCN_NAME_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PV1: [7, 8, 9, 17, 52], // attending / referring / consulting / admitting / other provider
  PD1: [4], // patient primary care provider
  ORC: [10, 11, 12, 19], // entered by / verified by / ordering provider / action by
  OBR: [10, 16, 28, 32, 33, 34, 35], // collector / ordering provider / copies-to / interpreters
  OBX: [16, 25], // responsible observer / performing org medical director
  DG1: [16], // diagnosing clinician
  PR1: [11], // procedure practitioner
  AIP: [3], // scheduled personnel
  TXA: [9, 10, 11], // originator / assigned authenticator / transcriptionist
  ROL: [4], // role person
};

const DOB_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [7], // patient date of birth
  NK1: [16], // next-of-kin date of birth
};
const ADDRESS_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [11], // patient address
  NK1: [4], // next-of-kin address
  GT1: [5], // guarantor address
  IN1: [19], // insured's address
};
const PHONE_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [13, 14], // home / business phone
  NK1: [5, 6, 7], // phone / business phone / contact phone
  GT1: [6, 7], // guarantor phone
};
// CX identifier lists (MRN / account / SSN-typed). Component 1 is the id, the
// 5th component is the CX identifier-type-code (`MR` / `AN` / `SS` / `SSN`).
const CX_ID_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [3, 18], // patient identifier list / account number
};
// Plain SSN fields (HL7 type ST, a bare number, not a CX list).
const SSN_ST_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [19], // SSN number - patient
};

// Name tokens that are HL7 name-type / degree / suffix / prefix codes, never a
// person's identifying name, extracted alongside real name tokens and skipped.
const NAME_NOISE_TOKENS = new Set<string>([
  "MD",
  "DO",
  "DR",
  "MR",
  "MRS",
  "MS",
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "RN",
  "NP",
  "PA",
  "PHD",
  "DDS",
  "DMD",
  "ESQ",
  "PROF",
  "FNP",
  "APRN",
]);

// Standard HL7 v2 segment ids. A segment id NOT in this set (a `Z…` site-defined
// segment, or anything unrecognized) has no known field schema, so it gets the
// unknown-segment name backstop rather than the precise field map. Mirrors
// `@cosyte/hl7`'s parser source of truth.
const KNOWN_SEGMENTS = new Set<string>([
  "MSH",
  "MSA",
  "EVN",
  "ERR",
  "SFT",
  "PID",
  "PD1",
  "MRG",
  "PV1",
  "PV2",
  "PDA",
  "PDC",
  "PEO",
  "DB1",
  "NK1",
  "GT1",
  "IN1",
  "IN2",
  "IN3",
  "ACC",
  "AL1",
  "DG1",
  "PRB",
  "IAM",
  "FAM",
  "GOL",
  "PR1",
  "OBR",
  "OBX",
  "ORC",
  "SPM",
  "TQ1",
  "TQ2",
  "NTE",
  "UB1",
  "UB2",
  "FT1",
  "RXA",
  "RXC",
  "RXD",
  "RXE",
  "RXG",
  "RXO",
  "RXR",
  "RXV",
  "SCH",
  "AIG",
  "AIL",
  "AIP",
  "AIS",
  "ARQ",
  "APR",
  "RGS",
  "TXA",
  "MFE",
  "MFI",
  "MFA",
  "MCP",
  "LDP",
  "LCH",
  "LOC",
  "LRL",
  "LCC",
  "ROL",
  "STF",
  "PRA",
  "EDU",
  "CER",
  "CTD",
  "CTI",
  "ORG",
  "PRC",
  "PRD",
  "QAK",
  "QPD",
  "QRF",
  "QRI",
  "QID",
  "RDF",
  "RDT",
  "DSC",
  "DSP",
  "EQL",
  "OMC",
  "FHS",
  "BHS",
  "BTS",
  "FTS",
  "CSR",
  "CSP",
  "CSS",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Hit {
  path: string;
  segment: string; // segment id + field (e.g. "PID-5") or "(text)"
  value: string;
  reason: string;
  /**
   * WHERE the bytes came from, set only when they are NOT the working-tree file
   * at `path`. `undefined` means the walk read the file on disk, which is what
   * every hit meant before the index corpus existed.
   *
   * It is stamped by the caller after a target is scanned, not passed down
   * through every detector: the detectors take a path and know nothing about
   * enumeration, and threading an origin through all nine of them would be a
   * wide change for a reporting concern.
   */
  origin?: string;
}

interface AllowList {
  /** Uppercase synthetic person-name tokens (XPN / XCN name components). */
  names: Set<string>;
  /** Synthetic dates of birth, normalized (YYYYMMDD or a bare YYYY year). */
  dobs: Set<string>;
  /** Synthetic street-address lines (XAD component 1), lower-cased. */
  addresses: Set<string>;
  /** Synthetic id values that legitimately match an SSN / bare-MRN shape. */
  ids: Set<string>;
  /** Allowed email domains (anything else is a hit). */
  emailDomains: Set<string>;
}

interface Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
}

interface Args {
  mode: "all" | "staged" | "paths";
  paths: string[];
  allowFixtures: string[];
}

class InvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvocationError";
  }
}

/**
 * The `errno` string of a Node system error (`ENOENT`, `EACCES`, ...), or
 * `undefined` for anything else. Narrowed with `in` rather than cast, so a
 * thrown non-error cannot masquerade as a system error.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const { code } = err;
  return typeof code === "string" ? code : undefined;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  let staged = false;
  const paths: string[] = [];
  const allowFixtures: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j += 1) {
        const v = argv[j];
        if (v !== undefined) paths.push(v);
      }
      break;
    } else if (a === "--staged") {
      staged = true;
      i += 1;
    } else if (a === "--allow-fixture") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new InvocationError("--allow-fixture requires a path argument");
      }
      allowFixtures.push(next);
      i += 2;
    } else if (a !== undefined && a.startsWith("--")) {
      throw new InvocationError(`Unknown flag: ${a}`);
    } else if (a !== undefined) {
      paths.push(a);
      i += 1;
    } else {
      i += 1;
    }
  }

  if (staged && paths.length > 0) {
    throw new InvocationError("--staged cannot be combined with positional paths");
  }

  // ▶ THE BYPASS IS UNIONED INTO THE TARGET LIST UNCONDITIONALLY, AND THE
  // CONDITIONAL SEED IT REPLACES WAS A FALSE-GREEN ROUTE.
  //
  // The old seed read `paths.length > 0 ? paths : [...allowFixtures]`, so
  // `--allow-fixture X` became a target ONLY when no positional path was given
  // and was a SILENT NO-OP the moment one was: `phi-scan <clean> --allow-fixture
  // <violator>` reported on `<clean>` alone and exited 0, having neither read
  // the violator nor said so. A flag must mean the same thing in every argv, so
  // it is unioned in every argv, deduped by repo-relative path (a positional and
  // a bypass can spell the same file two ways, and a duplicate target would read
  // the file twice for no gain).
  //
  // WHAT IT NOW MEANS is "enumerate this too, decline to open it, and REFUSE
  // (exit 2) for exactly that reason": there is no verdict a run may give about
  // a file it did not open, so there is no argv in which this flag reaches exit
  // 0. It is still not a MODE, so `--staged` is unaffected by the union and a
  // bypass naming an unstaged path is refused as unenumerated instead.
  const seen = new Set<string>();
  const scanPaths: string[] = [];
  for (const p of [...paths, ...allowFixtures]) {
    const key = normalizePath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    scanPaths.push(p);
  }

  let mode: Args["mode"];
  if (staged) {
    mode = "staged";
  } else if (scanPaths.length > 0) {
    mode = "paths";
  } else {
    mode = "all";
  }
  return { mode, paths: scanPaths, allowFixtures };
}

// ---------------------------------------------------------------------------
// Allow-list + override log
// ---------------------------------------------------------------------------

function loadAllowList(): AllowList {
  if (!existsSync(ALLOW_LIST_PATH)) {
    throw new InvocationError(`allow-list not found at ${ALLOW_LIST_PATH}`);
  }
  const raw = readFileSync(ALLOW_LIST_PATH, "utf8");
  const names = new Set<string>();
  const dobs = new Set<string>();
  const addresses = new Set<string>();
  const ids = new Set<string>();
  const emailDomains = new Set<string>();
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    if (value.length === 0) continue;
    switch (tag) {
      case "NAME":
        names.add(value.toUpperCase());
        break;
      case "DOB":
        dobs.add(value);
        break;
      case "ADDR":
        addresses.add(value.toLowerCase());
        break;
      case "ID":
        ids.add(value.toUpperCase());
        break;
      case "EMAILDOMAIN":
        emailDomains.add(value.toLowerCase());
        break;
      default:
        break;
    }
  }
  return { names, dobs, addresses, ids, emailDomains };
}

function normalizePath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  return rel.split(sep).join("/");
}

function loadOverrideLog(): Set<string> {
  if (!existsSync(OVERRIDE_LOG_PATH)) return new Set();
  const raw = readFileSync(OVERRIDE_LOG_PATH, "utf8");
  const out = new Set<string>();
  // Skip fenced code blocks, the doc's own "Format" example shows a literal
  // `### <path>` template that is NOT a real entry. Only `###` headings in prose
  // are override entries.
  let inFence = false;
  for (const lineRaw of raw.split(/\r?\n/)) {
    if (/^\s*```/.test(lineRaw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^###\s+(.+?)\s*$/.exec(lineRaw);
    if (m && m[1] !== undefined) out.add(normalizePath(m[1]));
  }
  return out;
}

function validateAllowFixtures(allowFixtures: string[]): void {
  if (allowFixtures.length === 0) return;
  const overrides = loadOverrideLog();
  const missing = allowFixtures.map(normalizePath).filter((p) => !overrides.has(p));
  if (missing.length > 0) {
    const lines = missing.map((p) => `  - ${p}`).join("\n");
    throw new InvocationError(
      `--allow-fixture rejected: no matching entry in phi-scan-overrides.md for:\n${lines}\n` +
        `Add a "### <path>" subsection to phi-scan-overrides.md and commit it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Target enumeration
// ---------------------------------------------------------------------------

interface Target {
  path: string; // forward-slash repo-relative path for reporting
  read: () => Buffer;
  /**
   * Which scan ROOT this target was enumerated under, set only in `all` mode.
   * It is what lets the sweep refuse when a root it WALKED contributed no
   * observed file, instead of only when the whole run observed nothing.
   */
  root?: string;
  /**
   * Absolute path, set only for a target the walk enumerated itself, so a
   * vanished file can be re-checked once the sweep has finished.
   */
  absPath?: string;
  /**
   * TOCTOU: true only for a file the scanner ENUMERATED ITSELF in `all` mode
   * AND that git does not track. `all` mode lists `test/` + `src/` first and
   * reads each file afterwards, so anything created and removed inside that
   * window makes the read throw `ENOENT`.
   *
   * This repo reaches that window through its OWN suite, which is what makes it
   * different from its sibling parsers. `test/scripts/phi-scan.test.ts` writes
   * live-capture fixtures into `mkdtemp`'d directories under `test/`, which IS
   * a walk root, and removes them again; measured, two such directories exist
   * for about 510 ms each per suite run. A sweep running beside that suite can
   * enumerate one and then fail to read it. (A repo-root build transient such as
   * `tsup.config.bundled_<hash>.mjs` is NOT enumerated here, because neither
   * walk root is the repo root, which is the accident that spared the siblings.
   * Widening a walk root removes it.)
   *
   * Only the ENUMERATION was unsound, never the refusal, so the fix is scoped
   * hard rather than by relaxing what a failed read means:
   *   - a TRACKED file is never tolerated. The committed corpus is what the
   *     gate promises to have observed, so if a tracked file cannot be read
   *     the scan is incomplete and still refuses (exit 2);
   *   - only `ENOENT` is tolerated. `EACCES`, `EISDIR` and friends are not a
   *     file that went away, they are a scan that failed;
   *   - a tolerated file is re-checked after the sweep and reported. If it is
   *     back on disk, the sweep did not observe a file that exists now, so the
   *     run refuses;
   *   - `paths` mode reads what the caller named, and `staged` mode reads blobs
   *     out of the git index (`git show :path`), so neither the CLI nor the
   *     pre-commit gate depends on this at all.
   *
   * RESIDUAL, stated rather than hidden: the re-check is keyed on the PATH the
   * walk enumerated, not on content. An untracked file RENAMED inside the window
   * is `ENOENT` at the old path and was never enumerated under the new one, so
   * its bytes go unscanned under a clean report. It is bounded: the file has to
   * be untracked, so committing it means `git add`, after which it is tracked
   * and untolerable, and pre-commit reads the index either way. Closing it needs
   * a content-addressed sweep, which is a different design, not a wider bound.
   */
  tolerateVanish?: boolean;
  /**
   * Set only on a target whose bytes came out of the git index rather than off
   * disk. It is stamped onto every hit that target produces, so a report can
   * say which of the two the finding is about; see `report`.
   */
  origin?: string;
}

/**
 * An entry the enumeration reached but cannot scan. Both fields are safe to
 * print: `path` is the entry's own repo-relative path (the same locus every hit
 * already carries) and `kind` is a token from the closed set below. Nothing off
 * the other side of a link is ever recorded here.
 */
interface Unscannable {
  path: string;
  kind: string;
}

/**
 * The predicates a `Dirent` and a `Stats` both answer. Typed structurally so one
 * closed-set describer serves both, without either being cast to the other.
 */
interface EntryKind {
  isSymbolicLink: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
}

/**
 * Closed-set, engine-owned description of an entry's kind, or `null` when NONE
 * of the predicates answered. `null` is not "a regular file", it is NO ANSWER,
 * and the caller must resolve it rather than report it. See `walk`.
 */
function nonRegularKind(e: EntryKind): string | null {
  if (e.isSymbolicLink()) return "a symbolic link";
  if (e.isFIFO()) return "a FIFO";
  if (e.isSocket()) return "a socket";
  if (e.isBlockDevice()) return "a block device";
  if (e.isCharacterDevice()) return "a character device";
  return null;
}

/**
 * Describe a path's OWN kind for a refusal, from an `lstat`, so a link is named
 * as a link and nothing on the other side of it is read or reported.
 */
function pathKind(p: string): string {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "not a directory";
  }
  if (st.isDirectory()) return "a directory";
  if (st.isFile()) return "a regular file";
  return nonRegularKind(st) ?? "not a directory";
}

/** `true` only when `p` is itself a symbolic link, whatever it resolves to. */
function isSymbolicLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A scan ROOT that is not a walkable directory REFUSES the scan (exit 2).
 *
 * The root is the one path the walk opens by name rather than reaching through a
 * typed `Dirent`, so it is the one path that can fail to be a directory at all,
 * and both ways of doing that read as clean or worse:
 *
 *   - a root that resolves to a FILE (a regular file at `test`, or a link to
 *     one) threw `ENOTDIR` out of `readdirSync` UNCAUGHT. Node exits **1** on an
 *     uncaught throw, which is the code this contract reserves for "hits found",
 *     so the gate reported a finding it had not made. Measured on `2252d33`;
 *   - a root that is a DANGLING link fails `existsSync`, which follows, so the
 *     walk returned silently and the sweep reported OK over the whole corpus
 *     that root stands for. `observed === 0` does not catch it while the other
 *     root still has files.
 *
 * Reading whatever sits there instead is refused as the remedy: what is missing
 * is a TREE, and one file read in its place would be evidence about that file
 * and not about the corpus it replaced. `staged` mode is a different matter and
 * does read such a blob, because the index has no directories in it to lose: see
 * `isScannableTestFile`.
 *
 * A root that is a link to a DIRECTORY is still followed, exactly as before.
 * That is pre-existing and link-NEUTRAL (the tree beyond it is scanned as the
 * root it replaced would have been, with that root's own limits), it is
 * disclosed in the banner, and re-deciding it is a question about repo layout
 * rather than about this defect.
 *
 * A root that is the wrong TYPE is collected rather than thrown on, so it comes
 * out alongside the other root's findings in one refusal. A root whose `stat`
 * itself fails throws where it stands, so that one is reported alone.
 *
 * This decision is taken BEFORE `gitIgnored` runs, so a gitignored root refuses
 * too, where a gitignored entry INSIDE a root is exempt. That asymmetry is
 * deliberate and disclosed: the exemption says a file is not commit-eligible
 * content, which is a statement about that file, and it cannot be a statement
 * about a whole corpus that is missing.
 */
function walkRoot(
  root: string,
  out: string[],
  unscannable: Unscannable[],
  badRoots: Unscannable[],
): boolean {
  let st;
  try {
    // statSync FOLLOWS, which is what keeps a linked directory root behaving as
    // it always has. The refusals below are decided on what it resolves TO.
    st = statSync(root);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw new InvocationError(
        `could not read the scan root ${normalizePath(root)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ENOENT is two different things. An ABSENT root is legitimate (a repo need
    // not have both), and a DANGLING link is a root that IS there and stands for
    // nothing. One lstat tells them apart.
    if (isSymbolicLink(root)) badRoots.push({ path: normalizePath(root), kind: pathKind(root) });
    return false;
  }
  if (!st.isDirectory()) {
    badRoots.push({ path: normalizePath(root), kind: pathKind(root) });
    return false;
  }
  walk(root, out, unscannable);
  // The root WAS a walkable directory, so it is one the sweep must go on to
  // observe files under. Reporting that is what lets `main` refuse per-root
  // rather than only when EVERY root came back empty; see the `observed` guard.
  return true;
}

/** The refusal block for every scan root that is not a walkable directory. */
function badRootBlock(roots: Unscannable[]): string | null {
  if (roots.length === 0) return null;
  const lines = roots.map((r) => `  - ${r.path} (${r.kind})`).join("\n");
  const noun =
    roots.length === 1 ? "scan root is not a directory" : "scan roots are not directories";
  return (
    `${String(roots.length)} ${noun}:\n${lines}\n` +
    "The walk enumerates a tree there, so it has nothing to observe, and anything read in place " +
    "of one would be evidence about a single entry rather than about the corpus that root stands " +
    "for. Restore it as a directory, or remove it."
  );
}

/**
 * Enumerate a scan root. `Dirent`'s predicates are lstat answers and are not
 * exhaustive: an entry that is neither a directory nor a regular file is
 * collected into `unscannable` rather than dropped, so the caller can refuse
 * instead of reporting clean over it.
 */
function walk(dir: string, out: string[], unscannable: Unscannable[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT: a directory gone between its parent's `readdir` and this one, one
    // phase before the read window `Target.tolerateVanish` documents. It narrows
    // the ENUMERATION, exactly as the `lstat` branch below does, and softens
    // nothing about what a failed READ means.
    if (errorCode(err) === "ENOENT") return;
    // Everything else is a walk that FAILED, and it used to leave the process
    // rather than the function: an uncaught throw exits 1, the code reserved for
    // "hits found". A refusal is exit 2 and names the directory.
    throw new InvocationError(
      `could not enumerate ${normalizePath(dir)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out, unscannable);
    } else if (e.isFile()) {
      // README/markdown docs may legitimately describe violator values; they
      // are documentation, not fixtures.
      if (e.name.toLowerCase().endsWith(".md")) continue;
      out.push(full);
    } else {
      // Deliberately NOT subject to the `.md` exemption above, nor to the
      // deliberate-violator exemption `scanTarget` applies to a named `.ts`
      // source. Both are judgements about a file whose bytes the walk could have
      // read; a link's name is no evidence at all about what is on the other
      // side. (The blanket `.ts` exclusion this used to name is gone; see
      // `DELIBERATE_VIOLATOR_SOURCES`.)
      const kind = nonRegularKind(e);
      if (kind !== null) {
        unscannable.push({ path: normalizePath(full), kind });
        continue;
      }
      // EVERY predicate answered false, which is what a `Dirent` looks like when
      // `readdir` returned no type for the entry (`DT_UNKNOWN`, which some
      // filesystems do). That is an ABSENT answer, not evidence of a non-regular
      // entry, and refusing on it would red every sweep on such a filesystem: a
      // gate that refuses with no fix available is a gate someone turns off. One
      // `lstat` turns the guess into an answer. Not reachable on the filesystem
      // this repo is developed and tested on, so it is unpinned, and stated here
      // rather than hidden.
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        // Gone between `readdir` and `lstat`, one phase before the read window
        // `Target.tolerateVanish` documents. An entry that no longer exists was
        // never part of the corpus, so this narrows the ENUMERATION and does not
        // soften what a failed READ means. Anything else is a walk that failed.
        if (errorCode(err) === "ENOENT") continue;
        unscannable.push({ path: normalizePath(full), kind: "not a regular file" });
        continue;
      }
      if (st.isDirectory()) {
        walk(full, out, unscannable);
      } else if (st.isFile()) {
        if (e.name.toLowerCase().endsWith(".md")) continue;
        out.push(full);
      } else {
        unscannable.push({
          path: normalizePath(full),
          kind: nonRegularKind(st) ?? "not a regular file",
        });
      }
    }
  }
}

/**
 * Refuse (exit 2) over entries the enumeration reached and cannot scan. EVERY
 * offender is named, not just the first: a developer who has to re-run the gate
 * once per link learns to distrust it.
 */
function unscannableBlock(entries: Unscannable[], why: string, remedy: string): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((u) => `  - ${u.path} (${u.kind})`).join("\n");
  const noun =
    entries.length === 1 ? "entry is not a regular file" : "entries are not regular files";
  return `${String(entries.length)} ${noun}:\n${lines}\n${why} ${remedy}`;
}

/** `unscannableBlock`, thrown. The staged route has only this one class to refuse over. */
function refuseUnscannable(entries: Unscannable[], why: string, remedy: string): void {
  const block = unscannableBlock(entries, why, remedy);
  if (block === null) return;
  throw new InvocationError(`refusing the scan: ${block}`);
}

function gitIgnored(paths: string[]): Set<string> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;
  try {
    // SECURITY: array-form execFileSync, no shell. Default (Buffer) encoding,
    // `encoding: "buffer"` with `input` is rejected by Node.
    const out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      input: paths.map(normalizePath).join("\0"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    for (const p of out.toString("utf8").split("\0")) {
      if (p.length > 0) ignored.add(p);
    }
  } catch {
    // `git check-ignore` exits 1 when nothing matches, treat as none ignored.
  }
  return ignored;
}

/**
 * THE TRACKED SET IS NOW THE INDEX'S OWN PATHS, read once by `readIndex` and
 * handed in, and that replaces a `gitTracked()` that swallowed its own failure.
 *
 * The old shape returned `null` when git could not answer or answered empty,
 * which switched the vanish tolerance off (fail closed for THAT bound) and then
 * let the sweep go on to publish a verdict over the working tree alone. The
 * bound it protected was never the problem; the verdict was. `all` mode now
 * reads the bytes git carries as part of the sweep, so a git that cannot answer
 * REFUSES (exit 2) instead, at `readIndex`, and this function is only ever
 * called with a populated set.
 */
function buildTargetsForAll(walkedRoots: string[], tracked: ReadonlySet<string>): Target[] {
  const unscannable: Unscannable[] = [];
  const badRoots: Unscannable[] = [];
  const testFiles: string[] = [];
  if (walkRoot(TEST_ROOT, testFiles, unscannable, badRoots)) walkedRoots.push("test");
  const srcFiles: string[] = [];
  if (walkRoot(SRC_ROOT, srcFiles, unscannable, badRoots)) walkedRoots.push("src");
  // From test/, keep every data file except .ts sources (dispatched to
  // structured-or-conservative by looksLikeHl7). From src/, keep everything
  // walk() surfaced (hand-written code → conservative pass).
  // Each file is tagged with the root it came from, so the sweep can prove it
  // observed something under EVERY root it walked rather than only in total.
  const files: { abs: string; root: string }[] = [
    ...testFiles
      .filter((abs) => isScannableTestFile(normalizePath(abs)))
      .map((abs) => ({ abs, root: "test" })),
    ...srcFiles.map((abs) => ({ abs, root: "src" })),
  ];
  // One `git check-ignore` over both lists. An ignored entry is already out of
  // scope for the file route, so applying the same rule to a non-regular entry
  // keeps a single boundary rather than inventing a second, stricter one for
  // links alone.
  const ignored = gitIgnored([...files.map((f) => f.abs), ...unscannable.map((u) => u.path)]);

  // ONE refusal carrying EVERY offender of BOTH kinds. A bad root and an
  // unscannable entry under the OTHER root are independent findings, and a
  // developer who has to re-run the gate to be told the second one learns to
  // distrust it, which is the reason `unscannableBlock` names them all too.
  const blocks = [
    badRootBlock(badRoots),
    unscannableBlock(
      unscannable.filter((u) => !ignored.has(u.path)),
      "The walk can neither read such an entry nor vouch for what is on the other side of it.",
      "Remove it, replace it with a regular file, or (if it is genuinely not part of the " +
        "corpus) untrack it and add it to .gitignore.",
    ),
  ].filter((b): b is string => b !== null);
  if (blocks.length > 0) {
    throw new InvocationError(`refusing the scan: ${blocks.join("\n")}`);
  }

  return files
    .map(({ abs, root }) => ({ abs, root, rel: normalizePath(abs) }))
    .filter(({ rel }) => !ignored.has(rel))
    .map(({ abs, root, rel }) => ({
      path: rel,
      root,
      read: () => readFileSync(abs),
      absPath: abs,
      tolerateVanish: !tracked.has(rel),
    }));
}

function buildTargetsForPaths(paths: string[]): Target[] {
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
    if (!existsSync(abs)) throw new InvocationError(`File not found: ${p}`);
    if (!statSync(abs).isFile()) throw new InvocationError(`Not a regular file: ${p}`);
    return { path: normalizePath(abs), read: () => readFileSync(abs) };
  });
}

/**
 * Refuse (exit 2) when an UNMERGED path sits under a scan root.
 *
 * An unmerged path has no stage-0 entry, so `git diff --cached --raw` emits it
 * as `U` and `--diff-filter=AMT` deletes the record: the route enumerated
 * NOTHING for it and reported "OK, no hits". Measured on `3daf2e9` with a
 * conflicted `test/differential/fixtures/*.frame.bin` whose BOTH stages carried
 * live-shaped PID-3 / PID-5 / PID-7 values, the raw output for that stage is
 * empty and `--staged` exited 0.
 *
 * SCANNING THE STAGES IS REFUSED AS THE REMEDY. Stages 2 and 3 are the two sides
 * of a conflict, and neither is what a commit would contain, so a hit on one
 * would be a claim about content that may never exist and a CLEAN on both would
 * be a claim about content that does not exist yet. The only true thing
 * available is that there is an entry here the route cannot account for.
 *
 * WHAT THIS IS WORTH, stated honestly rather than inflated: `git commit` itself
 * refuses an index with unmerged paths, and it refuses BEFORE the pre-commit
 * hook runs, so this is not a route by which PHI reaches a commit. What it fixes
 * is the gate ANSWERING A QUESTION IT CANNOT ANSWER when a developer or a script
 * runs `--staged` directly mid-conflict to ask what is about to be committed.
 * A false green is worse than a refusal even when nothing downstream depends on
 * it, because it is what teaches someone the gate has looked. Minor, and fixed
 * because it is three lines, not because it is severe.
 */
function refuseUnmergedPaths(): void {
  let out: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell. `-u -z` lists one record per
    // unmerged STAGE, NUL-separated, so a path appears two or three times.
    out = execFileSync("git", ["ls-files", "-u", "-z"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    throw new InvocationError(
      `git ls-files -u failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const paths = new Set<string>();
  for (const rec of out.toString("utf8").split("\0")) {
    if (rec.length === 0) continue;
    // `<mode> <sha> <stage>\t<path>`. Everything after the first TAB is the path,
    // which may itself contain spaces.
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const p = rec.slice(tab + 1);
    if (p.length > 0 && isUnderScanRoot(p)) paths.add(p);
  }
  if (paths.size === 0) return;
  const lines = [...paths].map((p) => `  - ${p} (unmerged)`).join("\n");
  const noun = paths.size === 1 ? "path is unmerged" : "paths are unmerged";
  throw new InvocationError(
    `refusing the scan: ${String(paths.size)} ${noun}:\n${lines}\n` +
      "An unmerged path has no single staged blob, so there is nothing this route can read " +
      "that is what a commit would contain. Resolve the conflict and `git add` it.",
  );
}

/** git's file modes for a regular blob. Every other mode is not a file to read. */
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);

/** Closed-set, engine-owned description of a git file mode. */
function gitModeKind(mode: string): string {
  if (mode === "120000") return "a symbolic link";
  if (mode === "160000") return "a gitlink (a nested repository)";
  return `a git mode-${mode} entry`;
}

/** `:<srcmode> <dstmode> <srcsha> <dstsha> <status>`, the info half of a `--raw -z` record. */
const RAW_RECORD = /^:(?:\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/;

function buildTargetsForStaged(): Target[] {
  // BEFORE the enumeration, because an unmerged path is invisible to it.
  refuseUnmergedPaths();
  let listBuf: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell. `--raw` rather than
    // `--name-only` because the DESTINATION MODE is the only thing that
    // distinguishes a staged regular file from a staged symbolic link, and
    // `git show :<path>` answers both without complaint.
    //
    // `T` (TYPECHANGE) IS IN THE FILTER, AND LEAVING IT OUT MADE THE MODE CHECK
    // BELOW UNREACHABLE WHENEVER THE FILE BEING REPLACED WAS ALREADY TRACKED.
    // Replacing a TRACKED regular file with a link is not an add and not a
    // modify; git raises it as `T` (`:100644 120000 <sha> <sha> T`), so
    // `--diff-filter=AM` deleted the record before any mode could be read and
    // the hook passed the link green. Measured on git 2.39.5 against a tracked
    // `test/differential/fixtures/*.frame.bin` replaced by a link: with `AM` the
    // raw output for that stage is EMPTY. Typechange carries a single path,
    // exactly like `A` and `M`, so admitting it costs the two-field stride below
    // nothing, and it also scans the reverse typechange (a link replaced by a
    // real file bearing PHI) as the file it became.
    //
    // `--no-renames` FOR THE SAME REASON, AND THE FILTER ALONE WAS NOT ENOUGH.
    // Rename detection is on by default, and `diff.renames` can turn copy
    // detection on as well, so `git mv <link> test/<name>` staged as
    // `:120000 120000 <sha> <sha> R100` with TWO paths, which `--diff-filter=AMT`
    // then deleted outright: an ordinary `git mv` put a mode-120000 entry under a
    // scan root and this route printed "OK, no hits" (measured on `2252d33`, exit
    // 0). A rename that ALSO substitutes a real name stages as a SCORED rename and goes the
    // same way, with live PID-5 / PID-7 / PID-3 values in the destination blob.
    // Turning detection off makes the destination arrive as an ordinary
    // single-path `A` (`:000000 120000 0000000 <sha> A`) and the source a `D` the
    // filter drops. It needs NO two-path record shape and no scope decision, and
    // it makes the two-field stride below STRUCTURAL rather than conditional: with
    // detection off git cannot emit an `R` or a `C` whatever the caller's
    // `diff.renames` is set to. Verified here under `diff.renames` = `true`,
    // `copies`, `false` and `1`, and under `diff.renameLimit=1`: every stage
    // yields single-path records and the enumeration is a strict superset of the
    // previous one.
    //
    // THE STRIDE BELOW IS COUPLED TO THIS ARGV, so read the coupling before
    // editing it. `--no-renames` is what makes a two-path record impossible, and
    // `-M`, `-C` and `--find-copies-harder` each turn detection back on over the
    // top of it: measured on a real rename stage, every one of the three empties
    // this route again. Do not add them. (`-B` is inert here, and a repeated
    // `--no-renames` after one of them closes it again: last one wins.) If a
    // two-path record ever did arrive, the stride desyncs and the run REFUSES
    // rather than scanning a short list, which is the safe direction, but that is
    // a backstop and not the guarantee.
    listBuf = execFileSync(
      "git",
      ["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=AMT"],
      {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new InvocationError(
      `git diff --cached failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // `--raw -z` emits `<info>\0<path>\0` per record. `R` (rename) and `C` (copy)
  // are the only statuses carrying a SECOND path, and `--no-renames` above means
  // git cannot emit either, so the stride is two fields. The regex still admits a
  // score-suffixed status: if one ever reached here the stride would desync and
  // the next record would fail to parse, which REFUSES, the same outcome as any
  // other unparseable record and the safe one. A record that does not parse
  // REFUSES rather than being skipped: a silently shortened list is exactly the
  // shape this scan must never report clean over.
  //
  // What this route still does NOT enumerate: `--diff-filter=AMT` also drops
  // `D`, and that one is correct, a deletion has no staged blob to scan.
  //
  // `U` IS ALSO DROPPED AND IS NOT CORRECT, so it is refused below rather than
  // left silent. See `refuseUnmergedPaths`.
  const fields = listBuf.toString("utf8").split("\0");
  const staged: { path: string; mode: string }[] = [];
  let i = 0;
  while (i < fields.length) {
    const info = fields[i];
    if (info === undefined || info.length === 0) {
      i += 1;
      continue;
    }
    const m = RAW_RECORD.exec(info);
    const mode = m?.[1];
    const path = fields[i + 1];
    if (mode === undefined || path === undefined || path.length === 0) {
      throw new InvocationError(
        "could not read the output of `git diff --cached --raw -z`: unrecognized record. " +
          "Refusing rather than scanning a list that may be short.",
      );
    }
    staged.push({ path, mode });
    i += 2;
  }

  // A NON-REGULAR entry is judged against the route's ROOTS only. The extension
  // rules in the read filter below are judgements about bytes; see the banner.
  refuseUnscannable(
    staged
      .filter((s) => isUnderScanRoot(s.path) && !REGULAR_BLOB_MODES.has(s.mode))
      .map((s) => ({ path: s.path, kind: gitModeKind(s.mode) })),
    "For such an entry `git show :<path>` hands back its target path rather than any content " +
      "(or fails outright), so scanning it would prove nothing about what it points at.",
    "Unstage it, or replace it with a regular file.",
  );

  return (
    staged
      .filter((s) => REGULAR_BLOB_MODES.has(s.mode))
      // Scan the same in-scope set all-mode walks: every test/ data file except
      // .ts sources (they carry deliberate violator literals), plus src/ code.
      // Both predicates admit the ROOT'S OWN PATH, which is the entry the walk
      // cannot have and the index can: see `isScannableTestFile`.
      .filter((s) => isScannableTestFile(s.path) || isScannableSrcFile(s.path))
      .map(({ path: relPath }) => ({
        path: relPath,
        // SECURITY: array-form execFileSync, no shell. `:<path>` is a git pathspec.
        read: (): Buffer =>
          execFileSync("git", ["show", `:${relPath}`], {
            encoding: "buffer",
            stdio: ["ignore", "pipe", "pipe"],
          }),
      }))
  );
}

// ---------------------------------------------------------------------------
// The index corpus: the bytes git carries
// ---------------------------------------------------------------------------

/**
 * ▶ THE WALK WAS THE ONLY THING ALL MODE EVER ASKED, AND A DIRECTORY OF DECOYS
 * ANSWERS IT.
 *
 * `all` mode walked `test/` and `src/` on disk and reported what it found there.
 * Nothing reconciled that against what git actually carries, so every state in
 * which the working tree stopped standing for the committed corpus printed
 * `[phi-scan] OK, no hits` and exited 0. Eight were measured on `6eb1615`,
 * each over a payload with a live-shaped PID-3 / PID-5 / PID-7 / PID-11:
 *
 *   - `test/` swapped for a directory MIRRORING the tracked names over clean
 *     contents (the sharp one: every root still yields, so no count and no
 *     path-set reconciliation can see it);
 *   - one tracked fixture replaced on disk by a clean decoy;
 *   - a tracked message under an UNDECLARED top-level directory, which is
 *     invisible to the walk (not under a root) and to `--staged` (not under
 *     `isUnderScanRoot`) alike;
 *   - a tracked file simply ABSENT from the working tree;
 *   - `test/` replaced by a SYMLINK to a directory of decoys (`readdirSync`
 *     follows, so the walk reads the decoys and calls the root healthy);
 *   - a tracked SYMLINK outside every walk root;
 *   - an UNMERGED index entry outside every walk root (`refuseUnmergedPaths` is
 *     scoped to `isUnderScanRoot`, so it never saw it);
 *   - an EMPTY index, against which any reconciliation passes vacuously.
 *
 * THE REMEDY IS A UNION, NOT A REPLACEMENT, AND THAT IS LOAD-BEARING. No walk
 * root was narrowed and no clause was dropped: a file the walk reads is still
 * read off disk and still earns exactly the tiers it had. What is added is a
 * second enumeration that reads the bytes git carries at every path in the
 * index, so the two routes together are a strict superset of the walk alone.
 *
 * THE SKIP IS A BYTE COMPARISON, NEVER A STAT, AN MTIME OR A HASH. `git
 * diff-files` and every timestamp test are precisely what a decoy defeats, and
 * a hash would bind this to the repository's object format. The blob is fetched
 * either way, so comparing it against what the walk already read costs one
 * `Buffer.equals` and skips only a path whose committed bytes have provably
 * been scanned already.
 *
 * ▶ IT IS DETECTIVE, NOT PREVENTIVE, ON EVERY ROUTE. This runs after the write
 * has landed in the index. It is not a hook and it does not stop a `git add`.
 *
 * ▶ WHAT THIS DELIBERATELY DOES NOT DO, so a later reader does not "finish" it:
 *   - it does not touch `--staged`. That route is the PRE-COMMIT gate, so what
 *     it enumerates decides what a commit is BLOCKED on. That is a hook decision
 *     with its own argument, and it has been declined three times on its own
 *     merits; it is not a side effect of this one.
 *     🛑 AND THE REASON IS NOT THE ONE A SIBLING RECORDS. The org-level note for
 *     this class says widening the predicate red-locks every commit touching the
 *     scanner's own suite, because `DELIBERATE_VIOLATOR_SOURCES` is `all`-mode
 *     only there. THAT IS FALSE HERE, measured: this repo applies the exemption
 *     in `scanTarget`, keyed on the path and blind to the mode, and
 *     `buildTargetsForStaged` already admits `test/**`, so the suite is in
 *     `--staged`'s scope today AND already exempt there. Do not repeat the
 *     red-lock sentence in this repo; the reason to leave `--staged` alone is
 *     that it decides what a commit is blocked on, and nothing more;
 *   - it does not credit the per-root observation rule. That rule is a statement
 *     about the WALK, so a root emptied on disk still refuses (exit 2) even
 *     though every file under it was just read out of the index;
 *   - it does not consult `.gitignore`. An entry in the index IS commit-eligible
 *     content by construction, whatever a pattern says about it.
 *
 * ▶ RESIDUAL, MEASURED AND NOT CLOSED: working-tree bytes at a path OUTSIDE
 * every walk root are read by neither route, tracked or not. A tracked file out
 * there with unstaged edits is judged on its staged bytes, and an untracked file
 * out there is not read at all. Closing it needs a third enumeration.
 *
 * ▶ 🛑 READING IS NOT THE SAME ACT AS TIERING, AND THIS ROUTE ONLY BUYS THE
 * FIRST. Every index entry is now READ, but WHICH detectors it earns is still
 * `looksLikeHl7`'s decision, unchanged by this work. Outside `test/` that gate
 * wants a `.hl7` or `.bin` name, so a tracked capture at
 * `examples/data/capture.txt`, or an extensionless one, gets the conservative
 * SSN/email floor and nothing else. Measured: the same bytes carrying PID-3 /
 * PID-5 / PID-7 / PID-11 exit **1** at `examples/data/capture.hl7` and **0** at
 * `examples/data/capture.txt`. Pinned as a characterization case, so the
 * boundary is visible rather than surprising.
 *
 * DO NOT "FIX" THAT BY GIVING EVERY INDEX ENTRY THE STRUCTURED SCAN. Handing
 * `package.json`, `pnpm-lock.yaml` or a workflow YAML to `scanHl7` is actively
 * wrong: any line of three word characters and a delimiter reads as a segment to
 * `SEGMENT_LINE_RE`, and an unrecognized id falls to `checkUnknownSegment`'s
 * name backstop, which would report identifiers and prose as person names. It
 * would also silently reverse the standing decision that `src/` keeps the
 * conservative pass. Widening the TIER rule is its own slice, with its own
 * argument, and this one deliberately does not take it: the enumeration was the
 * defect, and enumeration alone buys the SSN/email floor and nothing more.
 */
const INDEX_ORIGIN = "git index";

/**
 * The label for a path the walk DID read, whose committed bytes are not the
 * bytes on disk. Kept apart from `INDEX_ORIGIN` because the remedy differs: a
 * divergent path needs the corrected file re-staged, while a path the walk never
 * reached is fixed like any other file.
 */
const INDEX_DIVERGENT_ORIGIN = "git index; the working tree differs";

/** `maxBuffer` for the two LISTING calls, which return records and not content. */
const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling on the bytes one sweep will pull out of the object store. A repo past
 * this refuses BY NAME rather than dying in the allocator, which would surface
 * as an uncaught failure and exit 1: the code this contract reserves for "hits
 * found". This package used to vendor a packed `@cosyte/hl7` tarball, which is
 * what made the ceiling concrete rather than theoretical; the index is history,
 * so those blobs are still reachable and the ceiling still applies.
 */
const INDEX_BLOB_BUDGET_BYTES = 512 * 1024 * 1024;

interface IndexEntry {
  mode: string;
  oid: string;
  stage: string;
  path: string;
}

/** `<mode> SP <oid> SP <stage> TAB <path>`: one `git ls-files -s -z` record. */
const INDEX_RECORD = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/;

/**
 * Every entry the index holds, at every stage. `-z` is NUL-separated and
 * unquoted, so a path matches the walk's forward-slash relative paths exactly.
 *
 * A FAILURE HERE REFUSES rather than falling back to the working tree. That is
 * the whole difference from the `gitTracked()` this replaces: that one returned
 * `null` on failure, switched one tolerance off, and let the sweep publish a
 * verdict anyway.
 */
function readIndex(): IndexEntry[] {
  let out: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell.
    out = execFileSync("git", ["ls-files", "-s", "-z"], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: INDEX_LIST_MAX_BYTES,
    });
  } catch (err) {
    throw new InvocationError(
      `could not read the git index: ${err instanceof Error ? err.message : String(err)}. ` +
        "All mode reads the bytes git carries as well as the working tree, so it refuses " +
        "rather than reporting a verdict over the working tree alone.",
    );
  }
  const entries: IndexEntry[] = [];
  for (const rec of out.toString("utf8").split("\0")) {
    if (rec.length === 0) continue;
    const m = INDEX_RECORD.exec(rec);
    const mode = m?.[1];
    const oid = m?.[2];
    const stage = m?.[3];
    const path = m?.[4];
    if (mode === undefined || oid === undefined || stage === undefined || path === undefined) {
      // The raw record is NOT echoed. Every other refusal here names the paths
      // it refuses over, because a refusal nobody can act on is worse; but a
      // record this regex did not match has no known structure, so there is no
      // path in it to name, and printing unparsed bytes off the index is not
      // the same act as naming a path the code understood.
      throw new InvocationError(
        "could not read the output of `git ls-files -s -z`: unrecognized record. " +
          "Refusing rather than scanning a list that may be short.",
      );
    }
    entries.push({ mode, oid, stage, path });
  }
  return entries;
}

/**
 * The bytes behind each object id, in ONE `git cat-file --batch` call.
 *
 * `--batch-check` runs first for two reasons, neither of them caution for its
 * own sake: it is where a MISSING or non-blob object is refused by name before
 * anything is read, and its sizes are what `maxBuffer` is derived from. Node's
 * default `maxBuffer` is 1 MiB and this repo's tracked corpus is already past
 * that, so a guessed constant would be a gate that starts refusing as the
 * package grows.
 */
function readBlobs(oids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const input = `${oids.join("\n")}\n`;

  let checkBuf: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell. The input is object ids this
    // process read out of the index, never a path.
    checkBuf = execFileSync("git", ["cat-file", "--batch-check"], {
      input,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: INDEX_LIST_MAX_BYTES,
    });
  } catch (err) {
    throw new InvocationError(
      `could not query the git object store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const lines = checkBuf
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length !== oids.length) {
    throw new InvocationError(
      `git cat-file --batch-check answered for ${String(lines.length)} of ` +
        `${String(oids.length)} index objects. Refusing rather than scanning a list that may ` +
        "be short.",
    );
  }
  let total = 0;
  for (const line of lines) {
    // `<oid> blob <size>` for an object that is there, `<oid> missing` for one
    // that is not. An object id is a hash and carries no content, so it is safe
    // to name in a diagnostic; nothing else from the line is printed.
    const m = /^([0-9a-f]+) (\S+)(?: (\d+))?$/.exec(line);
    const oid = m?.[1];
    const type = m?.[2];
    const size = m?.[3];
    if (oid === undefined || type === undefined) {
      throw new InvocationError(
        "could not read the output of `git cat-file --batch-check`: unrecognized record.",
      );
    }
    if (type !== "blob" || size === undefined) {
      throw new InvocationError(
        `the git object store cannot hand back the content the index records at ${oid} ` +
          `(reported as: ${type}). The sweep cannot read what git carries, so it refuses ` +
          "rather than reporting on the working tree alone.",
      );
    }
    total += Number(size);
  }
  if (total > INDEX_BLOB_BUDGET_BYTES) {
    throw new InvocationError(
      `the index holds ${String(total)} bytes of scannable content, past this scanner's ` +
        `${String(INDEX_BLOB_BUDGET_BYTES)}-byte sweep budget. Refusing by name rather than ` +
        "failing in the allocator, which would not read as a scanner refusal.",
    );
  }

  let buf: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell. `maxBuffer` is the measured
    // total plus a header allowance (one `<oid> blob <size>` line and one
    // trailing newline per object), never a guess.
    buf = execFileSync("git", ["cat-file", "--batch"], {
      input,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: total + oids.length * 128 + 64 * 1024,
    });
  } catch (err) {
    throw new InvocationError(
      `could not read the git object store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // `<oid> SP blob SP <size> LF <content> LF` per record. Sizes are BYTE counts
  // and the content is binary-safe (this repo tracks framed `.frame.bin`
  // fixtures and a packed tarball), so the walk is done on the Buffer and never
  // on a decoded string: decoding first would move every offset after the first
  // multi-byte character.
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) {
      throw new InvocationError("`git cat-file --batch` output ended mid-record.");
    }
    const header = buf.toString("utf8", i, nl);
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    const oid = m?.[1];
    const size = m?.[2];
    if (oid === undefined || size === undefined) {
      throw new InvocationError(
        "could not read the output of `git cat-file --batch`: unrecognized record.",
      );
    }
    const start = nl + 1;
    const end = start + Number(size);
    if (end > buf.length) {
      throw new InvocationError(
        `\`git cat-file --batch\` returned less content than it declared for ${oid}.`,
      );
    }
    blobs.set(oid, buf.subarray(start, end));
    i = end + 1;
  }
  const wanted = new Set(oids);
  if (blobs.size !== wanted.size) {
    throw new InvocationError(
      `read ${String(blobs.size)} of ${String(wanted.size)} index objects. Refusing rather ` +
        "than scanning a corpus that may be short.",
    );
  }
  return blobs;
}

/**
 * One target per index entry whose bytes the walk has not already read.
 *
 * ▶ THE `.md` RULE IS `walk()`'s, COPIED RATHER THAN INVENTED, and it is the one
 * reason an index entry is not read here. Markdown may legitimately describe
 * violator values; that judgement does not change with the route that reaches
 * the file. It is also why `documentation/agent-notes.md`, `phi-scan-overrides.md`
 * and `docs-content/*.md` stay out of this corpus. Widening it is a separate
 * question with its own argument, and it is NOT this slice's.
 *
 * ▶ THE MODE REFUSAL IS PERMANENT, NOT TRANSIENT, AND THAT MATTERS HERE. A
 * mode-`120000` (symlink) or mode-`160000` (gitlink) entry anywhere in the index
 * refuses the whole sweep until it is removed. This repo tracks NEITHER today
 * (measured on `6eb1615`: every one of its 157 index entries is `100644`, and it
 * has no `.gitmodules`), so the arm costs nothing now. It would be fatal in a
 * repo with a real submodule, and the live way to acquire one here is an orphan
 * agent-worktree gitlink, which is exactly why the arm names its kind instead of
 * failing as an incidental read error.
 */
function buildTargetsForIndex(
  entries: readonly IndexEntry[],
  observed: ReadonlyMap<string, Buffer>,
): Target[] {
  // ▶ THE REFUSALS BELOW SEE EVERY ENTRY, WHATEVER IT IS NAMED. The `.md`
  // exemption is applied LAST, to the readable set only, and putting it first
  // was a real hole rather than a style point: it is a NAME exemption, and this
  // file already states (see the banner) that a name exemption must never be
  // carried over to an entry whose bytes the route cannot read, because a name
  // is no evidence at all about what is on the other side of a link. `walk()`
  // has always honoured that. Measured on the first draft of this route: a
  // tracked symlink at `hidden/<surname>-<given>-<dob>.md`, whose TARGET PATH is
  // the PHI surface git actually carries, exited 0 "OK, no hits", while the same
  // link named `.hl7` refused at exit 2. Ordering the filter after the refusals
  // is the whole fix; the guard did not need to grow.
  const unmerged = [...new Set(entries.filter((e) => e.stage !== "0").map((e) => e.path))];
  if (unmerged.length > 0) {
    const lines = unmerged.map((p) => `  - ${p} (unmerged)`).join("\n");
    const noun = unmerged.length === 1 ? "path is unmerged" : "paths are unmerged";
    throw new InvocationError(
      `refusing the scan: ${String(unmerged.length)} ${noun}:\n${lines}\n` +
        "The index carries no stage-0 entry for it, so there is no one object id for this " +
        "route to read. Resolve the conflict and `git add` it.",
    );
  }

  refuseUnscannable(
    entries
      .filter((e) => !REGULAR_BLOB_MODES.has(e.mode))
      .map((e) => ({ path: e.path, kind: gitModeKind(e.mode) })),
    // Covers BOTH kinds this can be, because they are not the same thing: for a
    // link git carries the target PATH, and for a gitlink it carries a commit id
    // in another repository. Neither is content, so scanning what git hands back
    // would prove nothing about what the entry refers to.
    "git carries a link target or another repository's commit id for such an entry, never " +
      "content, so scanning it would prove nothing about what it refers to.",
    "Remove it from the index, or replace it with a regular file.",
  );

  // NOW the `.md` name rule, and only over entries whose bytes this route can
  // actually read. It is `walk()`'s own rule, copied rather than invented:
  // markdown may legitimately describe violator values, and that judgement does
  // not change with the route that reaches the file.
  const readable = entries.filter(
    (e) => REGULAR_BLOB_MODES.has(e.mode) && !e.path.toLowerCase().endsWith(".md"),
  );
  const blobs = readBlobs([...new Set(readable.map((e) => e.oid))]);

  const targets: Target[] = [];
  for (const e of readable) {
    const bytes = blobs.get(e.oid);
    if (bytes === undefined) {
      throw new InvocationError(
        "the git object store did not hand back one of the objects the index records. " +
          "Refusing rather than reporting over a corpus that was not read.",
      );
    }
    const seen = observed.get(e.path);
    // ▶ THE COMPARISON MUST NOT NORMALIZE LINE ENDINGS FIRST, and this is the
    // one edit that would quietly reopen the escape. Under `eol=crlf` or
    // `core.autocrlf` every blob diverges from its working-tree file, so the
    // skip stops firing and every count doubles: fail-safe, but wrong-looking
    // enough that someone will want to "fix" it by normalizing before comparing.
    // Normalizing compares a DERIVED form of the two byte strings, and a decoy
    // that differs only in what the normalizer erases would then be skipped.
    // Neither condition is live here (this repo has no `.gitattributes` and
    // `core.autocrlf` is unset, measured on `6eb1615`), so the doubling is a
    // sibling's problem and the rule is written down before it is anyone's.
    if (seen !== undefined && seen.equals(bytes)) continue;
    targets.push({
      path: e.path,
      read: () => bytes,
      origin: seen === undefined ? INDEX_ORIGIN : INDEX_DIVERGENT_ORIGIN,
    });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// MLLP frame + HL7 v2 structural helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap an MLLP frame so the HL7 header segment is at the front of the payload.
 *
 * MLLP Release 1 framing is `VT (0x0B) + payload + FS (0x1C) + CR (0x0D)`. The
 * scanner strips a BOM, then ALL leading `VT` start-block bytes (double-framing
 * probe: two leading `VT`s), then a trailing `FS` end-block (optionally followed
 * by `CR` and/or `LF`). A frame with a MISSING end-block (`VT + payload`, no
 * `FS CR`) still has its `VT` removed and its payload scanned, the unwrap only
 * ever REMOVES framing bytes, never gates the scan on their presence, so no
 * malformed frame can bypass detection. Any residual mid-payload `FS`/`VT` byte
 * is harmless: `splitSegments` splits on `CR`/`LF`, so it can only cling to one
 * field of one segment while every other field is still scanned. Un-framed
 * fixtures (a bare `.hl7` file) pass through unchanged.
 */
function unwrapMllpFrame(text: string): string {
  return text
    .replace(/^\uFEFF/, "") // BOM
    .replace(/^\u000b+/, "") // MLLP VT start-block(s)
    .replace(/\u001c\r?\n?$/, ""); // MLLP FS end-block (+ optional CR/LF)
}

// A line is a segment when it starts with a 3-char id (letters+digits, HL7
// allows a leading letter) followed by a delimiter, not a letter/digit/space.
// Case-insensitive: the parser is lenient about segment case (lowercase `pid`),
// so the scanner must be too, or a mixed-case feed silently bypasses detection.
const SEGMENT_LINE_RE = /^([A-Za-z][A-Za-z0-9]{2})([^A-Za-z0-9\s])/;

/** The header segment line (MSH / FHS / BHS), if the message has one. */
function findHeaderLine(text: string): string | undefined {
  for (const raw of unwrapMllpFrame(text).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[\s]*/, "");
    const m = SEGMENT_LINE_RE.exec(line);
    if (m && m[1] !== undefined) {
      const id = m[1].toUpperCase();
      if (id === "MSH" || id === "FHS" || id === "BHS") return line;
    }
  }
  return undefined;
}

/**
 * A file gets the full structured HL7 scan only when it is fixture-like AND
 * contains at least one recognizable segment line after MLLP unwrap. Fixture-like
 * means: a `.hl7` file, a `.bin` frame, OR ANY data file under `test/` (which is
 * exactly the set `isScannableTestFile` admits, minus `.ts` sources, a live
 * capture the differential README says to drop here may arrive as `.txt` /
 * `.json` / extensionless, and must still earn the structured scan, not just the
 * conservative shape pass). The gate is load-bearing in BOTH directions:
 *   - it lets a header-less message still get the full structured scan rather
 *     than the text-only pass (a fixture whose first segment is not MSH); and
 *   - it keeps hand-written `src/` code (and any `.ts` file passed explicitly) on
 *     the conservative pass even when it embeds an `MSH|…` example string,
 *     parsing a `.ts` file as HL7 segments produces only noise.
 * A fixture-like file with NO recognizable segment line (a genuinely non-HL7
 * binary blob) falls through to the conservative dashed-SSN + email pass; so does
 * anything not fixture-like (src code, plain text outside test/).
 */
function looksLikeHl7(text: string, path: string): boolean {
  // The `test/` disjunct is `isScannableTestFile` itself rather than a second
  // copy of it, so the set that EARNS the structured scan cannot drift from the
  // set that is READ. It carries the root's own name with it: a blob staged at
  // exactly `test` replaced the fixture root, so it is judged with that root's
  // limits, and those include the structured scan. Without this the blob is read
  // and still reports clean, because the conservative pass models no fields (a
  // draft measured exactly that: exit 0 over PID-5 / PID-7 / PID-3).
  const isFixtureLike = path.endsWith(".hl7") || path.endsWith(".bin") || isScannableTestFile(path);
  if (!isFixtureLike) return false;
  if (findHeaderLine(text) !== undefined) return true;
  return unwrapMllpFrame(text)
    .split(/\r\n|\r|\n/)
    .some((raw) => SEGMENT_LINE_RE.test(raw.replace(/^[\s]*/, "")));
}

// ---------------------------------------------------------------------------
// Embedded HL7 in a TypeScript source
// ---------------------------------------------------------------------------

/** A `.ts` source under a scan root. Never a document; a container of literals. */
function isTypeScriptSource(relPath: string): boolean {
  return relPath.endsWith(".ts");
}

/**
 * A segment run inside a string literal. Capture 1 is the ANCHOR, capture 2 the
 * segment id. The anchor is a literal boundary, then optional spaces/tabs, then
 * a 3-character segment id and a `|`. Four anchors, and each is a spelling this
 * corpus actually uses:
 *
 *   - an opening QUOTE of any of the three kinds (`"PID|…"`);
 *   - an `\r` or `\n` ESCAPE, which is how several segments are written into one
 *     literal (`"MSH|…\rPID|…\r"`);
 *   - a REAL NEWLINE, which is how a multi-line template literal spells the same
 *     thing:
 *     ```
 *     const inbound = `MSH|^~\&|…
 *     PID|1||…`;
 *     ```
 *     Without it only the `MSH` run is recovered, and `scanHl7` SKIPS header
 *     segments, so a full patient identity on the following lines reported
 *     clean. Adding it costs nothing measurable: over the tracked `.ts` sources
 *     the recovered set is IDENTICAL with and without it, so it closes a shape
 *     rather than widening the net.
 *
 * THE `|` IS LOAD-BEARING AND IS NOT AN ARBITRARY NARROWING. Anchoring on "any
 * non-alphanumeric delimiter", which is what `SEGMENT_LINE_RE` does for a file
 * that IS a message, matched ordinary prose and identifiers all over the suite
 * (`ack-from-hl7`, `not-an-error-object`, `ERR_MODULE_NOT_FOUND`,
 * `net.createConnection`), which would have driven `checkUnknownSegment`'s name
 * backstop over English words and made the gate unusable. NO MATCH COUNT IS
 * WRITTEN HERE, DELIBERATELY: that figure was wrong four times and is not
 * reproducible by an independent reader, because raw anchor matches are an UPPER
 * BOUND on extractor runs (this function advances past each consumed run) rather
 * than the same quantity. The derivation command is in
 * `documentation/agent-notes.md`; run it rather than trusting a number. A gate that reds on prose is a gate someone
 * turns off, which is the same failure mode this file names elsewhere.
 *
 * ▶ THE `|` NARROWS THE ANCHOR, IT DOES NOT MAKE A RECOVERED RUN TRUSTWORTHY,
 * AND THE DIFFERENCE MATTERS. On THIS corpus every recovered id happens to be a
 * real HL7 segment id, but that is an observation about the tree today and NOT a
 * property of the rule: a `//` comment or a message string containing `\r` and
 * three word characters before a `|` is recovered exactly like a fixture, and
 * one already is (`test/client/correlator-controlid.test.ts` has prose parsed as
 * `MSA-3`). It is harmless only because `MSA` has no field map. A future comment
 * of the shape `\rZDS|1|<surname>^<given>` WOULD reach `checkUnknownSegment` and
 * red the gate on a comment. **Do not write down that the recogniser only ever
 * sees real segments.** The bound that actually holds is narrower: a recovered
 * run is scanned with the same field map a fixture gets, and a false hit is
 * answered the same way any other is, by declaring the token or moving the text.
 *
 * WHAT THIS COSTS, stated rather than hidden, and the list is not "one thing":
 *
 *   - a message written with a CUSTOM field separator (`MSH^~\&^…`, or the
 *     `_`-substituted delimiter probes in
 *     `test/ack-from-hl7/control-id-verbatim.test.ts`) is not recovered at all
 *     and gets the conservative pass only. A FILE that is such a message is
 *     unaffected, `detectDelimiters` still reads MSH-1 there;
 *   - a run anchored on an ESCAPE does not know which quote opened the enclosing
 *     literal, so it still ends at the first quote of ANY kind. An apostrophe in
 *     a name (`O'HALLORAN`) truncates such a run at the apostrophe and silently
 *     drops every field after it. A run anchored on a QUOTE does not have this
 *     problem: it ends only on its OWN quote (see `extractEmbeddedHl7`);
 *   - a segment split ACROSS a concatenation (`"PID|1||" + mrn + "^^^HOSP^MR"`)
 *     is recovered only as far as the first operand.
 *
 * Each of the three needs a real TypeScript literal parser, not a wider anchor,
 * and a wider anchor is precisely the prose-matching result above.
 */
const EMBEDDED_SEGMENT_RE = /(["'`]|\\r|\\n|\n)[ \t]*([A-Za-z][A-Za-z0-9]{2})\|/g;

/**
 * Recover the HL7 segments embedded in a TypeScript source, as one reconstructed
 * message per call (segments joined by `CR`, which is what `splitSegments` wants).
 *
 * WHY THIS EXISTS AT ALL, AND WHY WIDENING THE ENUMERATION WITHOUT IT WOULD HAVE
 * SHIPPED NOTHING. Every detector above assumes THE FILE IS THE DOCUMENT:
 * `findHeaderLine` and `splitSegments` work line-by-line and require the segment
 * id at the START of a line. In a `.ts` source the line starts with `const`, or
 * with the opening quote, so a message written as
 * `"PID|1||<mrn>^^^HOSP^MR||<family>^<given>||<dob>|F"` matches nothing.
 * Measured on `3daf2e9` against a probe file carrying exactly that shape: naming
 * the file EXPLICITLY on argv, which bypasses the enumeration entirely, still
 * exited 0 "OK, no hits", while the IDENTICAL payload written to a `.hl7` file
 * reported all five fields (PID-3 / -5 / -7 / -11). The bytes were always
 * detectable; nothing ever looked at them as HL7.
 *
 * So the widening is TWO-SIDED, and the recogniser is "in addition to" the
 * enumeration rather than "instead of" it. Removing either half restores the
 * false green.
 *
 * TypeScript escapes are resolved because HL7 sees the resolved bytes: `\\`
 * becomes one backslash (so an `MSH|^~\\&|` literal yields the real `^~\&`
 * encoding characters and `nameTokens`' escape stripping behaves as it does on a
 * file), and `\"` / `\'` / `` \` `` / `\t` become their characters. `\r` and `\n`
 * TERMINATE a run, because in HL7 they are the segment separator.
 *
 * A `${...}` interpolation is replaced by `_`, never dropped and never guessed
 * at. `_` is not a letter, so `nameTokens` splits on it and yields no name, and
 * it is not a digit, so no identifier or date detector fires on it. That is the
 * honest answer: the scanner cannot know a runtime value, and inventing one
 * would produce either a false hit or a false clean.
 */
function extractEmbeddedHl7(source: string): string {
  const segments: string[] = [];
  EMBEDDED_SEGMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBEDDED_SEGMENT_RE.exec(source)) !== null) {
    const anchor = m[1];
    const id = m[2];
    if (anchor === undefined || id === undefined) continue;
    // When the anchor IS the opening quote we know which quote closes the
    // literal, so only THAT one ends the run. Ending on any quote truncates a
    // name at an apostrophe (`O'HALLORAN`) and silently drops every field after
    // it. An escape-anchored run has no such knowledge and keeps the older,
    // wider rule; that residual is disclosed on `EMBEDDED_SEGMENT_RE`.
    const closer = anchor === '"' || anchor === "'" || anchor === "`" ? anchor : null;
    // Start at the segment id itself, dropping the anchor and any indentation.
    let i = m.index + m[0].length - id.length - 1;
    let out = "";
    while (i < source.length) {
      const c = source[i];
      if (c === undefined) break;
      // A real line break always ends the run: it is the segment separator, and
      // the next segment is picked up by the newline anchor on the next pass.
      if (c === "\n" || c === "\r") break;
      if (closer === null ? c === '"' || c === "'" || c === "`" : c === closer) break;
      if (c === "\\") {
        const n = source[i + 1];
        // `\r` / `\n` are the HL7 segment separator: end this run, and let the
        // regex pick the NEXT segment up from the same escape on the next pass.
        if (n === "r" || n === "n") break;
        if (n === "\\") {
          out += "\\";
          i += 2;
          continue;
        }
        if (n === '"' || n === "'" || n === "`") {
          out += n;
          i += 2;
          continue;
        }
        if (n === "t") {
          out += "\t";
          i += 2;
          continue;
        }
        // Any other escape is not one HL7 cares about; keep the backslash as-is.
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
    }
    if (out.length > 0) segments.push(out.replace(/\$\{[^}]*\}/g, "_"));
    // Never rewind: `lastIndex` only ever moves forward, so a pathological
    // source cannot make this loop fail to terminate.
    if (i > EMBEDDED_SEGMENT_RE.lastIndex) EMBEDDED_SEGMENT_RE.lastIndex = i;
  }
  return segments.join("\r");
}

/**
 * Resolve the message delimiters from the header segment. `MSH-1` is the
 * character immediately after the 3-char id; `MSH-2` (the encoding characters)
 * supplies component / repetition / escape. A header-less message has no
 * encoding declaration, so the HL7 defaults (`|^~\&`) apply.
 */
function detectDelimiters(text: string): Delimiters {
  const header = findHeaderLine(text);
  if (header === undefined) {
    return { field: "|", component: "^", repetition: "~", escape: "\\" };
  }
  const field = header.charAt(3) || "|";
  // Encoding chars run from index 4 up to the next field separator.
  let enc = "";
  for (let i = 4; i < header.length && header.charAt(i) !== field; i += 1) enc += header.charAt(i);
  return {
    field,
    component: enc.charAt(0) || "^",
    repetition: enc.charAt(1) || "~",
    escape: enc.charAt(2) || "\\",
  };
}

/** Split a raw message into segment field-arrays (index 0 = segment id). */
function splitSegments(text: string, d: Delimiters): string[][] {
  return unwrapMllpFrame(text)
    .split(/\r\n|\r|\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .map((s) => s.split(d.field));
}

/** Field N of a segment (1-indexed HL7 field position, non-MSH offset). */
function fieldAt(elems: string[], n: number): string {
  return elems[n] ?? "";
}

/** Escape-aware, unicode-aware name tokenizer. */
function nameTokens(value: string, d: Delimiters): string[] {
  // Drop HL7 escape sequences (\F\ \S\ \T\ \R\ \E\ \Xhh\ \Zxx\ …), they are
  // delimiter placeholders, not name characters.
  const esc = d.escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noEsc = value.replace(new RegExp(`${esc}[^${esc}]*${esc}`, "g"), " ");
  const out: string[] = [];
  for (const raw of noEsc.split(/[^\p{L}]+/u)) {
    if (raw.length === 0) continue;
    if (!/\p{L}/u.test(raw)) continue;
    // A single Latin letter is a middle initial, not identifying. A single CJK
    // ideograph / kana / hangul IS a name (Chinese/Korean surnames are 1 char),
    // so keep those.
    const isCjk = /[぀-ヿ㐀-鿿가-힯]/u.test(raw);
    if (raw.length < 2 && !isCjk) continue;
    out.push(raw);
  }
  return out;
}

function isNameToken(tok: string): boolean {
  if (NAME_NOISE_TOKENS.has(tok.toUpperCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Category detectors (segment + field-position aware)
// ---------------------------------------------------------------------------

function checkNameField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  familyIdx: number,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  if (value.length === 0) return;
  for (const rep of value.split(d.repetition)) {
    const comps = rep.split(d.component);
    // Inspect family / given / middle relative to the type's family index.
    for (const off of [0, 1, 2]) {
      const comp = comps[familyIdx + off];
      if (comp === undefined || comp.length === 0) continue;
      for (const tok of nameTokens(comp, d)) {
        if (!isNameToken(tok)) continue;
        if (!allow.names.has(tok.toUpperCase())) {
          hits.push({
            path,
            segment: `${segId}-${String(fieldNo)}`,
            value: tok,
            reason: "person-name token not in synthetic allow-list",
          });
        }
      }
    }
  }
}

function normalizeDob(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 8) {
    const d = digits.slice(0, 8);
    const month = Number(d.slice(4, 6));
    const day = Number(d.slice(6, 8));
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return d;
  }
  if (/^\d{6}$/.test(digits)) {
    // YYYYMM month-precision DTM (a valid HL7 partial DOB).
    const month = Number(digits.slice(4, 6));
    if (month < 1 || month > 12) return null;
    return digits;
  }
  if (/^\d{4}$/.test(digits)) return digits; // year-only precision
  return null;
}

function checkDobField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const dob = normalizeDob(rep.split(d.component)[0] ?? rep);
    if (dob === null) continue;
    if (!allow.dobs.has(dob)) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: dob,
        reason: "date of birth not in synthetic allow-list",
      });
    }
  }
}

function checkAddressField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const street = (rep.split(d.component)[0] ?? "").trim();
    // A street line: house number + at least one word (`123 Main St`).
    if (!/^\d+\s+\p{L}/u.test(street)) continue;
    if (!allow.addresses.has(street.toLowerCase())) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: street,
        reason: "street address not in synthetic allow-list",
      });
    }
  }
}

function checkPhoneField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const digits = rep.replace(/\D/g, "");
    // A real dialable number is >= 10 digits. The `555` fake-exchange
    // convention (555-01xx is reserved for fiction) marks a synthetic number.
    if (digits.length >= 10 && !digits.includes("555")) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: rep,
        reason: "phone number without the 555 fake-exchange convention",
      });
    }
  }
}

function checkCxField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const comps = rep.split(d.component);
    const id = (comps[0] ?? "").trim();
    const typeCode = (comps[4] ?? "").trim().toUpperCase();
    if (id.length === 0) continue;
    const idUpper = id.toUpperCase();
    const isSsnType = typeCode === "SS" || typeCode === "SSN";
    if (isSsnType) {
      if (/^\d{9}$/.test(id) && !allow.ids.has(idUpper)) {
        hits.push({
          path,
          segment: `${segId}-${String(fieldNo)}`,
          value: id,
          reason: "SSN-typed identifier (CX type SS) not in synthetic allow-list",
        });
      }
      continue;
    }
    // A bare 6-9 digit identifier is a real-looking MRN / account number (or a
    // 9-digit SSN dropped in the wrong slot). Synthetic fixtures use prefixed
    // shapes (MRN…, ACCT…, FAKE…), so a bare numeric id is suspect.
    if (/^\d{6,9}$/.test(id) && !allow.ids.has(idUpper)) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: id,
        reason: "bare-numeric MRN / account identifier not in synthetic allow-list",
      });
    }
  }
}

function checkSsnStField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  allow: AllowList,
  hits: Hit[],
): void {
  const digits = value.replace(/\D/g, "");
  if (/^\d{9}$/.test(digits) && !allow.ids.has(digits.toUpperCase())) {
    hits.push({
      path,
      segment: `${segId}-${String(fieldNo)}`,
      value,
      reason: "SSN (9-digit) not in synthetic allow-list",
    });
  }
}

/**
 * Unknown / `Z…` site-defined segments have no known field schema, so a name
 * could hide in any field. Backstop: within each field, flag an adjacent pair of
 * single-token name-shaped components (`Johnson^Maya`) whose tokens are not
 * allow-listed. Only runs on unknown segments, known code-bearing segments
 * (`OBX`, `OBR`, …) carry `CODE^Description^System` triples that this would
 * misread as names.
 */
function checkUnknownSegment(
  path: string,
  segId: string,
  elems: string[],
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (let f = 1; f < elems.length; f += 1) {
    const field = elems[f] ?? "";
    for (const rep of field.split(d.repetition)) {
      const comps = rep.split(d.component);
      const singleToken: (string | null)[] = comps.map((c) => {
        const toks = nameTokens(c, d).filter(isNameToken);
        // A name component is exactly one significant token (family or given).
        return toks.length === 1 && toks[0] !== undefined ? toks[0] : null;
      });
      for (let c = 0; c + 1 < singleToken.length; c += 1) {
        const a = singleToken[c];
        const b = singleToken[c + 1];
        if (a === null || a === undefined || b === null || b === undefined) continue;
        for (const tok of [a, b]) {
          if (!allow.names.has(tok.toUpperCase())) {
            hits.push({
              path,
              segment: `${segId}-${String(f)}`,
              value: tok,
              reason: "person-name token in site-defined segment not in synthetic allow-list",
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shape checks shared by HL7 and plain-text targets
// ---------------------------------------------------------------------------

function scanCommonShapes(path: string, content: string, allow: AllowList, hits: Hit[]): void {
  // Dashed SSN anywhere (covers OBX-5 / NTE free text and non-HL7 targets). The
  // regex is deliberately anchored on \b digit groups so it does not read as a
  // literal SSN to code-scanning tools.
  for (const m of content.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
    hits.push({ path, segment: "(ssn)", value: m[0], reason: "dashed SSN pattern" });
  }
  // Emails whose domain is not an allow-listed reserved / test domain.
  for (const m of content.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    const domain = (m[1] ?? "").toLowerCase();
    if (!allow.emailDomains.has(domain)) {
      hits.push({ path, segment: "(email)", value: m[0], reason: "email with non-test domain" });
    }
  }
}

// ---------------------------------------------------------------------------
// HL7 message scanner
// ---------------------------------------------------------------------------

/**
 * `commonShapes` is `false` for the reconstruction handed back by
 * `extractEmbeddedHl7`: its caller has already run `scanCommonShapes` over the
 * WHOLE source, which is a superset of the reconstruction, so running it again
 * here would report the same SSN or email twice for one occurrence.
 */
function scanHl7(
  target: Target,
  text: string,
  allow: AllowList,
  hits: Hit[],
  commonShapes = true,
): void {
  const d = detectDelimiters(text);
  for (const elems of splitSegments(text, d)) {
    // Segment ids are matched case-insensitively, the lenient parser accepts a
    // lowercase `pid`, so the scanner must normalize before every lookup or a
    // mixed-case feed silently escapes the per-field detectors.
    const segId = (elems[0] ?? "").toUpperCase();
    if (segId.length === 0) continue;
    // MSH-style header segments carry only routing metadata + delimiters; the
    // field offset differs and none of the PHI fields live there. Skip them.
    if (segId === "MSH" || segId === "FHS" || segId === "BHS") continue;

    if (!KNOWN_SEGMENTS.has(segId)) {
      checkUnknownSegment(target.path, segId, elems, d, allow, hits);
      continue;
    }

    for (const f of XPN_NAME_FIELDS[segId] ?? []) {
      checkNameField(target.path, segId, f, fieldAt(elems, f), 0, d, allow, hits);
    }
    for (const f of XCN_NAME_FIELDS[segId] ?? []) {
      checkNameField(target.path, segId, f, fieldAt(elems, f), 1, d, allow, hits);
    }
    for (const f of DOB_FIELDS[segId] ?? []) {
      checkDobField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of ADDRESS_FIELDS[segId] ?? []) {
      checkAddressField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of PHONE_FIELDS[segId] ?? []) {
      checkPhoneField(target.path, segId, f, fieldAt(elems, f), d, hits);
    }
    for (const f of CX_ID_FIELDS[segId] ?? []) {
      checkCxField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of SSN_ST_FIELDS[segId] ?? []) {
      checkSsnStField(target.path, segId, f, fieldAt(elems, f), allow, hits);
    }
  }
  // Cross-cutting shape checks over the whole payload (catches free-text PHI in
  // OBX-5 / NTE that the field map does not model). Runs on the UNWRAPPED payload
  // so an MLLP FS/VT byte can never mask an adjacent dashed-SSN / email match.
  if (commonShapes) scanCommonShapes(target.path, unwrapMllpFrame(text), allow, hits);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Scan one target and hand back THE BYTES IT OBSERVED, or `null` when the file
 * was tolerated as gone (see `Target.tolerateVanish`), which the caller reports
 * and counts, never silently discards.
 *
 * It returns the buffer rather than a boolean because the index corpus skips a
 * blob whose bytes the walk has already read, and that skip is a BYTE
 * comparison. Handing back the bytes is what makes the comparison possible
 * without reading any file twice.
 */
function scanTarget(target: Target, allow: AllowList, hits: Hit[]): Buffer | null {
  let buf: Buffer;
  try {
    buf = target.read();
  } catch (err) {
    // TOCTOU, see `Target.tolerateVanish`: an untracked file the walk enumerated
    // itself may be a transient that was removed before we reached it. Report it
    // as unobserved instead of refusing; every other failure, and any tracked
    // file, still refuses the whole scan.
    if (target.tolerateVanish === true && errorCode(err) === "ENOENT") return null;
    throw new InvocationError(
      `could not read ${target.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = buf.toString("utf8");
  // A `.ts` SOURCE IS NOT A DOCUMENT, so it is dispatched before `looksLikeHl7`
  // rather than through it. Two reasons, and the second is the sharp one:
  //   - its HL7 lives inside string literals, which every line-oriented detector
  //     above misses (see `extractEmbeddedHl7`);
  //   - handing raw TypeScript to `scanHl7` would be actively wrong. Any line
  //     beginning with three word characters and a delimiter reads as a segment
  //     to `SEGMENT_LINE_RE`, and an unrecognized id falls to
  //     `checkUnknownSegment`'s name backstop, which would report identifiers
  //     and prose as person names.
  if (isTypeScriptSource(target.path)) {
    // A deliberate-violator corpus is exempt from BOTH passes; see
    // `DELIBERATE_VIOLATOR_SOURCES` for why the conservative floor cannot be
    // kept here and why allow-listing its email instead is refused. It is still
    // enumerated and still read, so it is counted as OBSERVED.
    if (DELIBERATE_VIOLATOR_SOURCES.has(target.path)) return buf;
    // The conservative floor runs over the WHOLE source, not just the recovered
    // segments: a dashed SSN or a non-test-domain email in a comment, a variable
    // name or a fixture path is a hit wherever it sits.
    scanCommonShapes(target.path, text, allow, hits);
    // `src/` KEEPS THE CONSERVATIVE PASS ONLY, AND THAT IS A STANDING DECISION
    // THIS WORK DOES NOT REVERSE. Its JSDoc `@example` snippets carry
    // illustrative HL7 with synthetic names and MRNs that are deliberately not
    // held to the segment-aware detectors, which is why `looksLikeHl7` already
    // refuses `src/` the structured scan. Running the recogniser there would
    // reverse that decision silently, through a change whose subject is a
    // DIFFERENT root: `src/` was never the defect here, it was enumerated and
    // read by both routes all along. Measured, three `src/` files carry six
    // recoverable runs and all six are clean today, so this costs nothing now
    // and is a scope decision rather than a workaround. Widening `src/` to the
    // structured scan is its own slice, with its own argument.
    if (!isScannableSrcFile(target.path)) {
      const embedded = extractEmbeddedHl7(text);
      if (embedded.length > 0) scanHl7(target, embedded, allow, hits, false);
    }
    return buf;
  }
  if (looksLikeHl7(text, target.path)) {
    scanHl7(target, text, allow, hits);
  } else {
    // Non-HL7 target (hand-written src / test, plain-text notes, non-HL7 binary
    // byte/buffer fixture): conservative shape pass only, no segment model to
    // lean on. Binary noise decoded as utf8 cannot crash this; at worst it emits
    // no hits.
    scanCommonShapes(target.path, text, allow, hits);
  }
  return buf;
}

/**
 * `scanTarget`, with the target's ORIGIN stamped onto whatever hits it produced.
 *
 * The stamp happens here rather than inside the detectors because they take a
 * path and know nothing about enumeration: threading an origin through all nine
 * of them would be a wide change for what is purely a reporting concern. Only
 * hits appended by THIS call are stamped, so an earlier target's findings are
 * never relabelled.
 */
function scanAndAttribute(target: Target, allow: AllowList, hits: Hit[]): Buffer | null {
  const before = hits.length;
  const bytes = scanTarget(target, allow, hits);
  if (target.origin !== undefined) {
    for (let i = before; i < hits.length; i += 1) {
      const h = hits[i];
      if (h !== undefined) h.origin = target.origin;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Print the hits, or nothing at all when there are none.
 *
 * ▶ SPLIT FROM THE CLEAN LINE ON PURPOSE, AND THE SPLIT IS WHAT LETS `main`
 * PRINT BOTH. The three end-of-run refusals fire after the LAST read, so a run
 * that is both incomplete and carrying hits must print the hits and then still
 * refuse. The clean line is written by `main` only once every refusal has
 * passed, so `OK, no hits` can never appear beside one.
 */
function reportHits(hits: Hit[]): void {
  if (hits.length === 0) return;
  // Grouped by path AND origin, never by path alone: bytes read off the working
  // tree and bytes read out of the index are two different findings about one
  // path, and merging them under one heading would say the file on disk carries
  // something it does not. The file COUNT stays a count of paths, so a path
  // found both ways is one file.
  const byLocus = new Map<string, Hit[]>();
  for (const h of hits) {
    const key = `${h.path}\0${h.origin ?? ""}`;
    const arr = byLocus.get(key);
    if (arr) arr.push(h);
    else byLocus.set(key, [h]);
  }
  const paths = new Set<string>();
  let fromIndex = 0;
  for (const group of byLocus.values()) {
    const first = group[0];
    if (first === undefined) continue;
    paths.add(first.path);
    // ONLY the divergent ones. A pure `INDEX_ORIGIN` hit is a path the walk
    // never reached (outside every root, or absent from the tree), and there the
    // working-tree file is fixed exactly like any other, so telling the reader
    // to re-stage would send them looking for a difference that is not there.
    if (first.origin === INDEX_DIVERGENT_ORIGIN) fromIndex += group.length;
    const where = first.origin === undefined ? "" : ` (${first.origin})`;
    process.stderr.write(`[phi-scan] HIT: ${first.path}${where}\n`);
    for (const h of group) {
      process.stderr.write(
        `  segment=${h.segment} value=${JSON.stringify(h.value)} (${h.reason})\n`,
      );
    }
  }
  // ▶ THE FOOTER NO LONGER OFFERS `--allow-fixture` AS A REMEDY, AND THAT IS A
  // DECISION RATHER THAN AN OMISSION. A bypass withdraws a file from the read
  // set, and the completeness rule refuses (exit 2) over a target enumerated and
  // never read, so a developer following that printed remedy would be walked out
  // of exit 1 and into exit 2. A printed remedy that cannot reach the state it
  // promises is the same defect as one that reaches a false green, with the sign
  // flipped.
  //
  // ▶ AND THE ALLOW-LIST IS NOT A UNIVERSAL REPLACEMENT FOR IT, SO THIS FOOTER
  // MUST NOT SAY IT IS. It reaches a clean run only for a value one of its five
  // tags covers. TWO DETECTOR CLASSES HAVE NO TAG AT ALL and are keyed on a
  // CONVENTION instead: `checkPhoneField` takes no allow-list parameter and is
  // satisfied only by the `555` fake-exchange convention, and the dashed-SSN
  // branch of `scanCommonShapes` pushes unconditionally, so no declaration of
  // any kind silences it. Both of those had `--allow-fixture` as their only
  // audited remedy before the completeness rule, and now have none: the fixture
  // itself has to change. That is a real cost of this rule, it is named here
  // because the footer is where a developer meets it, and the general sentence
  // ("the allow-list is the only remedy") is REFUSED as an overclaim.
  process.stderr.write(
    `[phi-scan] ${String(hits.length)} hit(s) across ${String(paths.size)} file(s). ` +
      `If a value is genuinely synthetic, declare it in scripts/phi-allow-list.txt ` +
      `(tags: NAME, DOB, ADDR, ID, EMAILDOMAIN): a token-level, reviewed declaration is ` +
      `the only remedy that reaches a clean run for a value one of those tags covers. ` +
      `TWO CLASSES HAVE NO TAG and are keyed on a convention instead, so the fixture has ` +
      `to change: a phone number needs the 555 fake-exchange convention, and a dashed-SSN ` +
      `shape is reported wherever it appears and cannot be declared at all. A whole-file ` +
      `--allow-fixture bypass is recorded in phi-scan-overrides.md and then REFUSED ` +
      `(exit 2), because a scan that never opened a file has no clean verdict to give ` +
      `about it.\n`,
  );
  if (fromIndex > 0) {
    // Named explicitly, because the remedy differs: these bytes are the ones git
    // carries, and they are not the bytes on disk. Editing the file alone does
    // not clear them.
    process.stderr.write(
      `[phi-scan] ${String(fromIndex)} of those are in bytes git carries at that path rather ` +
        `than in the working-tree file, so re-staging the corrected file is part of the fix.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  let args: Args;
  let allow: AllowList;
  try {
    args = parseArgs(process.argv.slice(2));
    validateAllowFixtures(args.allowFixtures);
    // LOADING THE ALLOW-LIST BELONGS INSIDE A GUARD, and it sat outside one: a
    // missing allow-list threw its `InvocationError` past every catch in this
    // function. See the process-level guard at the end of the file for the rest
    // of that class.
    allow = loadAllowList();
  } catch (err) {
    if (err instanceof InvocationError) {
      process.stderr.write(`[phi-scan] ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const allowed = new Set<string>(args.allowFixtures.map(normalizePath));

  let targets: Target[];
  const walkedRoots: string[] = [];
  // Only `all` mode reads the index corpus, so only `all` mode holds one here.
  let index: IndexEntry[] | null = null;
  try {
    if (args.mode === "staged") targets = buildTargetsForStaged();
    else if (args.mode === "paths") targets = buildTargetsForPaths(args.paths);
    else {
      index = readIndex();
      if (index.length === 0) {
        // AN EMPTY INDEX IS NOT A CLEAN CORPUS, IT IS NO CORPUS. `git ls-files`
        // exits 0 with NO output for a removed `.git/index` (a corrupt one exits
        // non-zero and lands in the catch above), and this route's whole promise
        // is to read what git carries. With nothing there it would contribute
        // nothing and the sweep would silently decay to the walk-only shape this
        // change exists to replace, while still printing a clean verdict.
        //
        // It also replaces the old `gitTracked()` empty-answer rule, which fixed
        // the narrower half of this: an empty tracked set made EVERY file
        // untracked, the one state in which the tracked-file bound stops
        // existing. That bound is still protected, now by refusing outright.
        throw new InvocationError(
          "refusing the scan: the git index holds no entries, so there is no committed " +
            "corpus to read and every check against it would pass vacuously. Run this from " +
            "a repository with a populated index.",
        );
      }
      targets = buildTargetsForAll(walkedRoots, new Set(index.map((e) => e.path)));
    }
  } catch (err) {
    if (err instanceof InvocationError) {
      process.stderr.write(`[phi-scan] ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  // ENUMERATED: every path this run DECLARED it would read, captured BEFORE any
  // withdrawal. Everything the read filters dropped upstream (a `.md` on either
  // sweeping route, a gitignored entry, a staged path outside `isUnderScanRoot`)
  // never became a target and is not in here, which is why the completeness rule
  // below does not fire on them. What it catches is a path that BECAME a target
  // and then did not get opened. The index route's targets are added to it as
  // they are built, below: a tracked path whose bytes the walk already read
  // verbatim never becomes a second target, and it is already in `read`.
  const enumerated = new Set<string>(targets.map((t) => t.path));
  // READ: filled in only once a target's bytes have actually been through
  // `scanTarget`. Evidence of observation, never a plan to observe.
  const read = new Set<string>();

  const hits: Hit[] = [];
  const vanished: Target[] = [];
  const observedByRoot = new Map<string, number>(walkedRoots.map((r) => [r, 0]));
  // What the walk actually READ, keyed by path. The index corpus below skips a
  // blob whose bytes are already in here, so nothing is read or reported twice,
  // and a path whose working-tree bytes DIFFER is scanned both ways.
  const observed = new Map<string, Buffer>();
  for (const t of targets) {
    // ▶ THE WITHDRAWAL HAPPENS HERE, AND NOWHERE EARLIER. `--allow-fixture` used
    // to remove the target from the list before the loop, which left no evidence
    // that the run had ever claimed the file: a withdrawn target and a target
    // read clean were the same state by the time anything counted. Skipping it
    // in the read loop leaves the path in `enumerated` and out of `read`, which
    // is exactly the difference the completeness rule refuses on.
    if (allowed.has(t.path)) continue;
    try {
      const bytes = scanAndAttribute(t, allow, hits);
      if (bytes !== null) {
        read.add(t.path);
        observed.set(t.path, bytes);
        if (t.root !== undefined) observedByRoot.set(t.root, (observedByRoot.get(t.root) ?? 0) + 1);
      } else vanished.push(t);
    } catch (err) {
      if (err instanceof InvocationError) {
        process.stderr.write(`[phi-scan] ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  // A tolerated file is never silent, and the tolerance is only good while the
  // file is still gone: if it is back on disk the sweep skipped something that
  // exists, which is an incomplete scan and refuses like any other.
  if (vanished.length > 0) {
    const back = vanished.filter((t) => t.absPath !== undefined && existsSync(t.absPath));
    if (back.length > 0) {
      process.stderr.write(
        `[phi-scan] could not read ${back.map((t) => t.path).join(", ")}: vanished mid-scan and is ` +
          `present again, so the sweep did not observe it. Re-run with the tree at rest.\n`,
      );
      return 2;
    }
    process.stderr.write(
      // "gone" rather than "deleted": a rename leaves the enumerated path just
      // as absent, and the residual on `Target.tolerateVanish` is about exactly
      // that case, so the line must not assert the file was removed.
      `[phi-scan] skipped ${String(vanished.length)} untracked file(s) gone between ` +
        `enumeration and read: ${vanished.map((t) => t.path).join(", ")}\n`,
    );
  }

  // THE INDEX CORPUS, `all` mode only: the bytes git carries, at every path it
  // carries them, whether or not that path sits under a walk root and whether or
  // not the working tree still agrees with it. The mechanism, everything it
  // closes and everything it deliberately does not do are written down once, at
  // `buildTargetsForIndex` and the section above it.
  //
  // IT RUNS AFTER THE VANISH ACCOUNTING ABOVE, deliberately: that block can
  // refuse, and this route can refuse, and a tolerated skip must be disclosed on
  // the paths where THIS route is the one that returns. Nothing in the block
  // above has a data dependency on the index route, so its disclosure stays
  // unconditional.
  //
  // ITS TARGETS ARE NOT CREDITED TO `observedByRoot`, deliberately. The per-root
  // rule below is a statement about the WALK: a root emptied on disk still
  // refuses even though every file under it was just read out of the index.
  if (index !== null) {
    let indexTargets: Target[];
    try {
      indexTargets = buildTargetsForIndex(index, observed);
    } catch (err) {
      if (err instanceof InvocationError) {
        // A REFUSAL MUST NOT SWALLOW A REAL HIT. An unmerged path or a tracked
        // link ANYWHERE in the index refuses the sweep, and the walk may already
        // have found PHI under a root that yielded perfectly well. Printing the
        // refusal alone would make this route's output strictly worse than the
        // base commit's for that input. The exit code is still 2, because an
        // incomplete sweep is not a verdict whatever it found on the way.
        reportHits(hits);
        process.stderr.write(`[phi-scan] ${err.message}\n`);
        return 2;
      }
      throw err;
    }
    // Added to the DECLARATION set whether or not the bypass withdraws them: a
    // path this route built a target for is a path the run said it would read,
    // and the completeness rule is the thing that notices when it did not.
    for (const t of indexTargets) enumerated.add(t.path);
    for (const t of indexTargets) {
      if (allowed.has(t.path)) continue;
      try {
        // The bytes are already in memory, so this cannot fail the way a
        // working-tree read can, and it can never be tolerated as vanished.
        scanAndAttribute(t, allow, hits);
        read.add(t.path);
      } catch (err) {
        if (err instanceof InvocationError) {
          reportHits(hits);
          process.stderr.write(`[phi-scan] ${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
  }

  // Refuse a sweep that observed nothing UNDER ANY ROOT IT WALKED. (`staged`
  // legitimately has nothing to scan when a commit touches only `.md`, and
  // `paths` is bounded by the caller's argv, so neither is guarded.)
  //
  // THE COUNTER USED TO BE GLOBAL, AND A GLOBAL COUNTER CANNOT SEE THIS. It only
  // fires when EVERY root comes back empty, so one healthy root masks an empty
  // one indefinitely. Measured on `3daf2e9`: adding `test/differential/fixtures/`
  // to `.gitignore` removed the ENTIRE `test/` corpus (after the `.ts` exclusion
  // of the day, three `.frame.bin` files) from the sweep, and the run printed
  // "OK, no hits" and exited 0 on the strength of `src/`'s 32 files alone. The
  // banner above this guard used to ASSERT that "`all` mode always reaches the
  // committed fixture corpus under `test/`"; nothing checked the assertion.
  //
  // A DENOMINATOR IS NOT THE REMEDY, and printing one would have looked like the
  // fix while changing nothing: the count in that measurement was 32, which is a
  // perfectly healthy-looking number, because a count counts the roots that DID
  // exist. What has to be checked is per-root, and it has to be keyed on the
  // roots the walk actually entered, so an ABSENT root (a repo need not have
  // both) stays legitimate while an EMPTIED one refuses.
  //
  // ▶ IT NO LONGER RETURNS ON THE SPOT. It is one of THREE end-of-run refusals
  // that are ACCUMULATED and printed together, for the same reason
  // `badRootBlock` and `unscannableBlock` name every offender in one message: a
  // developer who has to re-run a gate to be told the second finding learns to
  // distrust it. The exit code is unchanged (2) and so is the wording.
  const refusals: string[] = [];
  if (args.mode === "all") {
    const empty = [...observedByRoot.entries()].filter(([, n]) => n === 0).map(([r]) => r);
    if (walkedRoots.length === 0 || empty.length > 0) {
      const which =
        walkedRoots.length === 0 ? "no scan root" : `${empty.map((r) => `${r}/`).join(", ")}`;
      refusals.push(
        `[phi-scan] refusing: the all-mode sweep observed no files under ${which}, so it ` +
          `proves nothing about that corpus. Check .gitignore, the allow-fixture list, and ` +
          `that the tree is intact.\n`,
      );
    }
  }

  // A BYPASS MUST NAME A PATH THIS RUN ENUMERATES. It is a DIFFERENT claim from
  // the completeness rule and both are kept: this one is about a flag naming a
  // path the run never had in scope (so the flag subtracts nothing and reads as
  // a live bypass while doing nothing, which is how a stale override log drifts
  // unnoticed); that one is about a path the run DID have in scope and then
  // never opened. A set difference here too, and every offender is named.
  const unmatched = [...allowed].filter((p) => !enumerated.has(p)).sort();
  if (unmatched.length > 0) {
    refusals.push(
      `[phi-scan] refusing: --allow-fixture names ${String(unmatched.length)} path(s) this run ` +
        `does not enumerate, so the flag subtracts nothing:\n` +
        `${unmatched.map((p) => `  - ${p}`).join("\n")}\n` +
        `Scan a corpus that contains the path, or drop the flag and remove the entry from ` +
        `phi-scan-overrides.md if the file is gone.\n`,
    );
  }

  // THE COMPLETENESS RULE. A SET DIFFERENCE, NEVER A SIZE COMPARISON: a count
  // counts the targets that DID get read, so `n read of n targets` is exactly
  // the arithmetic that hides which ones did not. See the banner for the
  // measurement and for why `--allow-fixture` can no longer reach exit 0.
  //
  // THE ONE EXCEPTION IS BUILT FROM WHAT ACTUALLY VANISHED, never from what was
  // allowed to vanish: `vanished` holds only targets whose read threw `ENOENT`
  // under `tolerateVanish`, and it has already survived the came-back re-check
  // above, which refuses. A target withdrawn by `--allow-fixture` can never
  // reach it, because the read loop skips such a target before `scanTarget` is
  // ever called.
  const tolerated = new Set<string>(vanished.map((t) => t.path));
  const unread = [...enumerated].filter((p) => !read.has(p) && !tolerated.has(p)).sort();
  if (unread.length > 0) {
    const noun = unread.length === 1 ? "target was" : "targets were";
    refusals.push(
      `[phi-scan] refusing the scan: ${String(unread.length)} ${noun} enumerated and never ` +
        `read:\n${unread.map((p) => `  - ${p}`).join("\n")}\n` +
        `A scan that did not open a file has no clean verdict to give about it, so the run ` +
        `reports incompleteness rather than a result. If the values in it are genuinely ` +
        `synthetic, declare them in scripts/phi-allow-list.txt, which is the only remedy that ` +
        `reaches a clean run: a whole-file --allow-fixture bypass is recorded in ` +
        `phi-scan-overrides.md and then REFUSED here.\n`,
    );
  }

  // A REFUSAL MUST NOT SWALLOW A REAL HIT, the same rule the index route's
  // refusal above carries, and these three are the only refusals in this file
  // that fire after the LAST read: their hit list is complete for the corpus
  // that was actually opened, so suppressing it would throw away work a human
  // still has to act on. Exit stays 2: an incomplete sweep is not a verdict,
  // whatever it found on the way.
  reportHits(hits);
  if (refusals.length > 0) {
    for (const line of refusals) process.stderr.write(line);
    return 2;
  }

  if (hits.length > 0) return 1;
  process.stdout.write("[phi-scan] OK, no hits\n");
  return 0;
}

/**
 * NO FAILURE OF THIS SCAN MAY EXIT 1, BECAUSE 1 MEANS "HITS FOUND".
 *
 * Every throw that reached the top of the process used to become an uncaught
 * exception, and node exits 1 on one: a gate publishing a finding it never made,
 * which is worse than a crash because it reads as actionable. Three live routes
 * did it (a walk root that was not a directory, a missing allow-list, an
 * unreadable allow-list or override log) and all three now exit 2. Only the
 * first two are answered where they arise; the unreadable ones reach THIS guard,
 * so do not delete it believing they are covered elsewhere. Exit 2 is
 * the honest answer for all of them: the scan did not complete, so it proves
 * nothing, and non-zero still blocks the commit either way.
 *
 * What it prints is engine text naming a path this scanner passed IN, which is
 * the same locus every hit already carries. It never resolves a link, so nothing
 * from the other side of one reaches it.
 */
function run(): number {
  try {
    return main();
  } catch (err) {
    process.stderr.write(
      `[phi-scan] refusing: the scan failed before it could finish: ` +
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 2;
  }
}

process.exit(run());
