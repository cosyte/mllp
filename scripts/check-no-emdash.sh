#!/usr/bin/env bash
# scripts/check-no-emdash.sh
# Brand rule (founder directive, 2026-07-24): cosyte never uses the em dash.
# The em dash (U+2014) reads as an AI tell, so it is banned outright across
# every cosyte surface. Source of truth: `knowledgebase/06-brand/voice-and-tone.md`
# ("No em dashes. Ever."), which names commit messages explicitly.
#
# Ported into mllp on 2026-07-27. It is COMPOSED from three sibling copies rather than
# taken from any one of them, because no single existing copy is right for this repo:
#
#   * BASE: website's NUL-exclusion shape ([website#52](https://github.com/cosyte/website/pull/52),
#     `85f84ff`). A file containing a NUL byte is excluded as binary by an explicit,
#     reviewable rule; everything else is scanned WITHOUT `-I`. See the BINARY EXCLUSION
#     section below for why this repo needs that and what it costs.
#   * PLUS the two route fixes ncpdp found ([ncpdp#34](https://github.com/cosyte/ncpdp/pull/34),
#     `39212bb`): every scanned path is `./`-prefixed so a tracked file named exactly `-`
#     cannot be read as standard input, and `-d skip` is not used, so a tracked symlink to
#     a directory cannot pass silently. `-H` is added so every hit carries its filename.
#   * PLUS dicom's binary-match diagnostic branch ([dicom#33](https://github.com/cosyte/dicom/pull/33),
#     `83c425a`), so a red caused by a match inside input grep reads as binary says so,
#     instead of blaming an I/O failure that did not happen.
#
# Measured byte-level over all 152 tracked files before the port, and this is the whole
# measurement, not a markdown sample (a markdown-only count is what wrongly cleared dicom):
#   * ZERO tracked files carry U+2014, as the literal character or in any encoded form.
#     So this gate changed no content in this repo. It exists purely to stop a regression,
#     which is the only reason to add a gate to a clean tree.
#     ZERO files hold a NUL byte. This read ONE until ADR 0032 deleted
#     `vendor/cosyte-hl7-0.0.0.tgz`, a real gzip stream and the only binary this repo tracked.
#     THE BINARY EXCLUSION STAYS; its section explains why the specimen leaving does not
#     retire the shape. The live count is on the OK line, not here.
#   * THREE files are what GIT calls binary (`git ls-files --eol` reports `i/-text`), which is
#     a WIDER set than the NUL rule and is the one worth naming, because it is where the
#     exclusion could start biting without anyone noticing. They are
#     `test/differential/fixtures/r1-ack-aa.frame.bin`, `r1-adt-a01.frame.bin` and
#     `r1-oru-r01.frame.bin`: git classifies them binary on its LONE-CR branch, since an
#     HL7 v2 segment terminator is CR with no LF. They hold ZERO NUL bytes, so `has_nul`
#     keeps them IN scope and they are scanned as text. Proved rather than assumed, the way
#     ncpdp proved its `.xml` fixtures are read: each of the three was seeded with a live em
#     dash in turn and the gate went RED on each, naming the file.
#   * ZERO tracked gitlinks (no mode 160000 entry) and ZERO tracked symlinks.
#   * Every tracked file decodes as UTF-8 (the one exception was that tarball).
#
# The fix is never to re-encode the character: rewrite the sentence with a
# period, a colon, a comma, or parentheses.
#
# Two modes:
#   check-no-emdash.sh                 scan every tracked file
#   check-no-emdash.sh --stdin LABEL   scan text on stdin (CI feeds it the PR
#                                      title, body, and commit messages: the
#                                      voice rule names commit messages, and a
#                                      commit-message em dash is the near-miss
#                                      that prompted the gate in knowledgebase)
#
# Note: this script itself is excluded from the tracked-file scan (it necessarily
# names the encodings it bans). It matches by codepoint and by encoding, so it
# never contains the literal character.
#
# ---------------------------------------------------------------------------
# BINARY EXCLUSION, and why this repo does NOT take the knowledgebase/ncpdp/dicom shape.
#
# Those copies scan every tracked file with no binary partition at all, which is correct
# for a repo with no binaries: a match inside a NUL-bearing file then reds through the
# stderr capture instead of being skipped. That is fail-closed and it is the better shape
# where it applies.
#
# It does not apply here, and the reason is DURABILITY, not a present-day red. The argument was
# made against a specimen that has since left the repo, and it OUTLIVES it; read to the end
# before concluding the shape can now be relaxed.
#
# Measured at the time: `vendor/cosyte-hl7-0.0.0.tgz` did NOT contain the byte sequence
# `E2 80 94`, so a knowledgebase-shape script would have passed over it, and dicom's copy was
# run against that exact tree to confirm it rather than assume it (it printed OK, exit 0).
# But that tarball was a compressed byte stream, and a compressed stream contains any given
# three-byte sequence by coincidence with real probability. It was re-vendored by hand
# whenever `@cosyte/hl7` was rebuilt, and the next re-vendor could have landed a copy holding
# those bytes. Measured, not argued: appending those three bytes to the real tarball and
# re-running dicom's copy made it exit 1 with `binary file matches` against the tarball. That
# red has NO REMEDIATION AVAILABLE: you cannot rewrite a compressed byte stream with a period,
# and the tarball's contents are not prose anyone wrote. A gate whose red state has no defined
# fix is a gate someone disables, which is strictly worse than the hole it closed.
#
# THE TARBALL IS GONE (ADR 0032) AND THIS SHAPE STAYS. The property that forced it, an
# unremediable red on bytes nobody authored, belongs to tracked binaries as a class, not to
# that one file. Revisit the PARTITION if you must, never the ban.
#
# Do not read website's stated reason across to here. website regenerates 7 PNGs on every
# PR, so it quoted a per-PR probability. mllp has exactly one binary, it is static, and it
# changes only on a deliberate hand re-vendor. The shape is the same; the arithmetic is not,
# and there is no per-PR exposure here at all.
#
# Bare `-I` is NOT the alternative, and this is the part worth keeping. `-I` asks grep's
# heuristic "does this look like text", and that heuristic also skips a genuine TEXT file
# whose encoding is broken, so an em dash inside one would be missed in silence. That is the
# exact failure this whole script exists to refuse. So the partition is made here, by a rule
# that is explicit and reviewable rather than heuristic: a file containing a NUL byte is
# binary and out of scope for a prose rule; everything else is scanned WITHOUT `-I`, so
# nothing text-shaped is ever skipped quietly.
#
# Be exact about what GNU grep 3.8 actually does with a mis-encoded TEXT file, because the
# inherited one-line version of this claim is not quite right and the difference decides
# whether the red arrives on stdout or on stderr. Measured here, LC_ALL=C.UTF-8, no NUL:
#   * invalid byte on a DIFFERENT line from the match: an ordinary line hit on stdout.
#     Red through fail_with_hits. `-I` does not skip it either.
#   * invalid byte on the SAME line as the match: grep cannot print that line, so it writes
#     `binary file matches` to STDERR with empty stdout. Red through refuse_if_incomplete,
#     and the diagnostic branch there names the case. WITH `-I` the same file is skipped in
#     total silence (no stdout, no stderr, exit 0) and the gate prints OK over a live em
#     dash. That single case is the whole argument for `no -I`, and it was checked red, and
#     checked green with `-I` added, against this repo's real tree.
# Either way, without `-I`, the run reds. That is the property being bought.
#
# THE COST, stated rather than left implicit, because it is a real hole in a ban whose own
# wording has no exceptions: a tracked TEXT file that happens to hold a NUL byte (a UTF-16
# document, a fixture carrying framing bytes) is excluded here and its em dash would be
# missed. It was said for the tarball without softening, and the measurement stands as the
# demonstration even though the file is gone: seeding the real `vendor/cosyte-hl7-0.0.0.tgz`
# with a live em dash made THIS GATE PRINT OK AND EXIT 0. That is a MISS, not a pass. It is
# the deliberate price of the durability argument above, and it was checked rather than
# reasoned, along with the control that proves the NUL rule is what causes it: the same
# tarball bytes with every NUL replaced, carrying the same em dash, went RED.
# mllp has NO tracked file with a NUL today, so the exclusion currently exempts nothing.
# Read the count off the OK line rather than from here.
#
# Do NOT round that off to "the hole is hypothetical here", which an earlier draft of this
# header did. The at-risk fixture class ALREADY EXISTS: the three `.frame.bin` captures under
# `test/differential/fixtures/` are framed HL7 v2, git already classifies them binary, and
# `test/differential/fixtures/README.md` invites the next maintainer to replace any of them
# with a real capture from a live adapter run. They carry no NUL today and are demonstrably
# scanned (see the measurement list at the top). A live capture that carried one would leave
# this scan silently, with nothing in CI to say so. The tell is the excluded count on the OK
# line: it reads 1 today, and anything higher wants a look rather than a shrug.
# Closing it properly needs a rule about what a text file IS (the `.gitattributes`
# declaration pathways prefers, which no parser repo has yet), and that is an ecosystem-wide
# EMDASH-CONFORMANCE question, not something to grow this guard for.
# If a NUL-bearing TEXT fixture ever lands, revisit this partition rather than the ban.
#
# One property of a red on those fixtures, written down because it was seen rather than
# reasoned about: fail_with_hits echoes the matching LINE, an HL7 v2 frame is CR-delimited
# with no LF, so an entire message prints as "line 1" in a public CI log. That is acceptable
# here and is not worth machinery to truncate, because these fixtures are synthetic by policy
# and the policy is itself gated: `pnpm phi-scan` unwraps the MLLP frame and scans the payload
# at pre-commit and in CI. It is recorded so nobody rediscovers it during an incident.
# ---------------------------------------------------------------------------
# DISCLOSED RESIDUALS. Inherited from the shared shape knowingly. They are ONE cross-repo
# fix across every copy, not one fix per repo, so they are not fixed here. Do not patch
# them in this copy alone: a divergent variant is worse than a known shared limit.
#
#   (i)  The NUL exclusion above. Shared in kind with website, and its "what is a text
#        file" half is the same open question every copy has.
#   (ii) Encoded-form matching is LITERAL: case-sensitive, and the HTML entities require
#        the semicolon. So `%e2%80%94` (lowercase), `&#X2014;` (capital X), `&#x2014` (no
#        semicolon) and `&#08212;` (zero-padded) all pass this gate. The literal UTF-8
#        character, the canonical URL encoding, the JS escape, and the three canonical
#        entities are what is caught. Widening the pattern is the cross-repo fix.
#  (iii) The scan reads file CONTENTS only, never file NAMES. A tracked path that itself
#        carries an em dash passes green as long as its contents are clean. A filename is
#        a cosyte surface and the ban says "ever", so this is a real gap rather than a
#        scoping choice, but closing it widens what every copy covers.
#
#   NOT a residual here, and it is the one place this copy is strictly stronger than
#   ncpdp's and dicom's: their stderr capture binds only to the LAST stage of a three-stage
#   pipeline, so if their `grep -zvxF` self-exclusion filter or their `sed -z` path prefixer
#   died, the gate would print OK and exit 0. This copy builds the scan list in a bash loop
#   and does the self-exclusion and the `./` prefixing there, so the scan is a SINGLE
#   command and the stderr capture binds to all of it. It also uses no `sed -z`, which is
#   GNU-only and, unlike `grep -P`, has no self-test: on the documented Homebrew `gnubin`
#   setup (GNU grep on PATH, BSD sed) their copies print OK over a live character. This one
#   cannot, because there is no sed in it.
#
#   Also worth knowing: GNU grep 3.8 classifies a file as binary on ANY encoding error, not
#   only on a NUL byte. See the KNOWN LIMIT note further down for what that means for a
#   fixture deliberately encoded in a legacy charset.
# ---------------------------------------------------------------------------
set -euo pipefail

# LOCALE PIN, load-bearing. `grep -P` compiles `\x{NNNN}` as a Unicode codepoint only
# in PCRE's UTF-8 mode, which GNU grep enables from the locale. Under LC_CTYPE=POSIX
# (a bare container, cron, `sh -c`, any shell that inherits no locale) GNU grep 3.8
# instead ABORTS with "character code point value in \x{} or \o{} is too large".
# An earlier version of this gate in a sibling repo discarded that on stderr and
# `|| true`d the pipeline, so it printed OK having scanned nothing. Do not remove the
# pin, and do not restore the stderr redirect.
#
# The pin cannot be traded for a raw-byte pattern: `\xe2\x80\x94` matches the em dash
# under POSIX but NOT under a UTF-8 locale, where PCRE reads it as three characters.
# One pattern cannot cover both, so the locale is fixed and the pattern follows it.
#
# It also pins grep's DIAGNOSTIC MESSAGES to English, which the binary-match branch in
# refuse_if_incomplete reads. That branch is a message refinement only, so a locale that
# somehow escaped this pin would cost a clear diagnostic, never the red.
export LC_ALL=C.UTF-8

# Matches U+2014 as the literal character and as its encodings: %E2%80%94 (URL),
# the JS backslash-u escape, and the &mdash; / &#8212; / &#x2014; HTML entities.
# See residual (ii) above for exactly which near-misses this does NOT catch.
PATTERN='\x{2014}|%E2%80%94|\\u2014|&mdash;|&#8212;|&#x2014;'

# SELF-TEST: prove the scanner can still see what it is meant to catch before any
# clean result is believed. `printf` emits U+2014 as its UTF-8 bytes, so this file
# still never contains the literal character. Scope the claim honestly: this proves
# the PATTERN compiles and matches, not that the scan reached every tracked file.
# The refusals below are what cover the second half.
if ! printf 'a\xe2\x80\x94b\n' | grep -qP "$PATTERN"; then
  echo "ERROR: check-no-emdash - the scanner cannot match a known em dash." >&2
  echo "       grep -P is unavailable or not in UTF-8 mode (LC_ALL=${LC_ALL})." >&2
  echo "       Refusing to report a clean tree on a scanner that cannot see." >&2
  exit 1
fi

fail_with_hits() {
  local what="$1" hits="$2"
  echo "$hits" >&2
  echo "" >&2
  echo "ERROR: check-no-emdash - em dash (U+2014, or an encoded form) found in ${what}." >&2
  echo "       cosyte never uses em dashes (founder directive; 06-brand/voice-and-tone.md)." >&2
  echo "       Rewrite with a period, colon, comma, or parentheses." >&2
  exit 1
}

# Anything the scanner writes to stderr means either that it did not read everything it
# was given, or that it matched inside input it classifies as binary. Neither may print
# OK, and exit status cannot carry either signal: grep exits 1 on "no match", which xargs
# in turn reports as 123, so "clean" and "died part way through the batch" are
# indistinguishable by code, while a binary match exits 0 with empty stdout.
ERRLOG=$(mktemp)
FILELIST=$(mktemp)
TEXTLIST=$(mktemp)
STDINBUF=$(mktemp)
trap 'rm -f "$ERRLOG" "$FILELIST" "$TEXTLIST" "$STDINBUF"' EXIT

# Which mode is running, so the diagnosis below can name the right cause.
SCAN_MODE=files

refuse_if_incomplete() {
  [ -s "$ERRLOG" ] || return 0
  cat "$ERRLOG" >&2
  echo "" >&2
  # GNU grep >=3.5 prints "grep: FILE: binary file matches" on STDERR and nothing on
  # stdout, so a match in input grep cannot read as text arrives here rather than in
  # HITS. Name that case explicitly: without this branch the run reds saying the scan
  # did not read all of its input, which sends a reader hunting an I/O failure that
  # never happened. This branch only chooses the wording. Every path below exits 1, and
  # if grep's wording ever changes the run still reds through the generic message.
  # (On GNU grep older than 3.5 the same diagnostic went to STDOUT, which lands in HITS
  # and reds through fail_with_hits instead. Both vintages red; only the message differs.)
  if grep -qi 'binary file' "$ERRLOG"; then
    echo "ERROR: check-no-emdash - the input named above MATCHED the banned pattern, but" >&2
    echo "       grep classifies it as binary, so the hit is reported without a line" >&2
    echo "       number. Treat it as a real em dash." >&2
    if [ "$SCAN_MODE" = stdin ]; then
      echo "       The text piped in is not valid UTF-8. Fix the encoding of whatever" >&2
      echo "       produced it, then rewrite the sentence." >&2
    else
      echo "       Files holding a NUL byte are excluded as binary BEFORE this scan runs," >&2
      echo "       so this is a TEXT file with a broken encoding. Repair the encoding (it" >&2
      echo "       should be UTF-8), then rewrite the sentence." >&2
    fi
    echo "       cosyte never uses em dashes (founder directive; 06-brand/voice-and-tone.md)." >&2
  fi
  if grep -qiv 'binary file' "$ERRLOG"; then
    echo "ERROR: check-no-emdash - the scan reported errors, so it did not read all of" >&2
    echo "       its input. Refusing to report green from an incomplete scan." >&2
  fi
  exit 1
}

# ---- stdin mode: text that is not a file (commit messages, PR title and body) ----
if [ "${1:-}" = "--stdin" ]; then
  SCAN_MODE=stdin
  LABEL="${2:-stdin}"
  # Buffer stdin to a file first, for the same reason the file mode builds its list as
  # its own command: empty input must be refused, not reported green. A caller whose
  # redirect silently produced nothing (a missing file, a `git log` that wrote to a
  # different stream, a mis-typed heredoc) would otherwise get OK from a scan that read
  # nothing, which is the exact blind-gate shape this script exists to refuse. The
  # shipped workflow always emits at least the title line, so this only ever fires on a
  # genuinely broken caller.
  cat > "$STDINBUF"
  if [ ! -s "$STDINBUF" ]; then
    echo "ERROR: check-no-emdash - nothing arrived on stdin for ${LABEL}. Refusing to" >&2
    echo "       report green from a scan that read nothing." >&2
    exit 1
  fi
  HITS=$(grep -nP -e "$PATTERN" -- "$STDINBUF" 2>>"$ERRLOG" || true)
  refuse_if_incomplete
  [ -n "$HITS" ] && fail_with_hits "$LABEL" "$HITS"
  echo "check-no-emdash: OK (no em dashes in ${LABEL})"
  exit 0
fi

# ---- default mode: every tracked file ----
#
# `git ls-files` is relative to the working directory, so from a subdirectory it
# lists a subtree and the scan would report OK having skipped the rest of the repo.
# Anchor at the top level, which also keeps the self-exclusion path below correct.
cd "$(git rev-parse --show-toplevel)"

# The choices below each close a route by which the scan could report green without
# having actually read its input, because a gate that prints OK when it did not read
# its input is worse than no gate at all. Each was checked RED in this repo, with a
# seeded fixture per route, before the port landed.
#
# This list is NOT a claim of exhaustiveness. The `-` operand was found by a refuter
# against a copy whose own comment implied it was already closed. Treat this as the
# routes that are known and closed, not as proof that no other exists.
#
#   the file list is built as its own command, not as the head of the pipeline, so a
#   `git ls-files` that fails (an unreadable or corrupt index) stops the run. Piped,
#   its status is erased by the `|| true` the no-match case needs, and the scan would
#   report OK over an empty list. An empty list is refused for the same reason.
#
#   -z, and -0 on the xargs below: `git ls-files` C-quotes any path holding a space, a
#   quote, or a non-ASCII byte, and unseparated, grep is then handed a name no file has.
#   -r on xargs drops the grep invocation entirely when the list is empty; without it
#   grep falls back to reading stdin and prints OK.
#
#   -e before the pattern and -- after it, so neither the pattern nor a tracked filename
#   that starts with a dash is read as a grep option. A file named `-q` would otherwise
#   silence the whole batch and the gate would print OK.
#
#   EVERY PATH IS `./`-PREFIXED as the list is built, which is what actually closes the
#   dash family. `--` alone does NOT: it stops `-` being parsed as an OPTION, but grep
#   then reads the bare operand `-` as STANDARD INPUT, and xargs points its child's stdin
#   at /dev/null. A tracked file literally named `-` (a `cmd > -` typo, which `git add -A`
#   stages without complaint) is therefore never opened, and the gate prints OK and exits
#   0 over a live em dash. Checked RED here, not inherited on faith. Prefixing in the loop
#   rather than through `sed -z` also keeps the scan a single command, so the stderr
#   capture binds to all of it, and drops a GNU-only dependency that has no self-test.
#
#   -H so every hit carries its filename. grep omits the name when it is handed exactly
#   one file, which an xargs batch boundary can produce, and an unattributable hit in a
#   red build is a worse report for no saving.
#
#   NO -d skip. It is the one fail-OPEN flag in this pipeline's ancestry: with it, a
#   tracked symlink to a directory is skipped silently (no stderr, so
#   refuse_if_incomplete never fires and the gate goes green). It is not needed, because
#   the loop below refuses a tracked entry that is not a regular file BY NAME, which is
#   louder still. Note that the plain `[ -d "$f" ]` test website uses would reopen the
#   same hole from the other side: `-d` follows symlinks, so a symlink to a directory
#   tests true and would be skipped as if it were a gitlink. Hence the `! -L` guard.
#
#   no -I: see BINARY EXCLUSION in the header. NUL-bearing files are partitioned out
#   explicitly first, and everything else is scanned without the heuristic, so a
#   mis-encoded TEXT file reds loudly instead of being skipped in silence.
#
#   KNOWN LIMIT, stated because mllp is a parser-adjacent repo where it is plausible. The
#   pattern matches U+2014 as UTF-8 and as the five textual encodings listed with it. It
#   does NOT match an em dash encoded in some other charset, and an HL7 v2 payload whose
#   MSH-18 declares a legacy charset (CP1252 0x97, or an ISO-IR set) is exactly the kind
#   of grounded fixture this repo carries. Measured, not assumed: such a file scans clean
#   and this gate stays GREEN. There is none today. The -I discussion does not rescue it:
#   GNU grep 3.8 DOES classify such a file as binary (any encoding error is enough, a NUL
#   is not required), but it surfaces that as the "binary file matches" diagnostic only
#   when the pattern actually matches, and a pattern written in UTF-8 never matches a bare
#   CP1252 0x97. So nothing reaches refuse_if_incomplete and the run stays quiet. This is
#   not a wholesale skip of mixed-encoding files: a UTF-8 em dash on another line of the
#   same file is still caught normally, and that case DOES go red.
#   This is accepted rather than fixed: the ban is a rule about prose that people write,
#   and fixture bytes are grounded data, not brand copy. If a legacy-charset fixture ever
#   lands, a reviewer covers it, not this script. Do not widen the pattern to chase it,
#   and do not re-add -I.
#
#   stderr is captured and any of it fails the run (see refuse_if_incomplete above).
git ls-files -z > "$FILELIST"

if [ ! -s "$FILELIST" ]; then
  echo "ERROR: check-no-emdash - no tracked files to scan. Refusing to report green" >&2
  echo "       from a scan that read nothing." >&2
  exit 1
fi

# A file containing a NUL byte is binary and out of scope for a prose rule. Read the
# bytes rather than asking a heuristic: `wc -c` against the same file with NULs stripped.
has_nul() {
  local size nonul
  size=$(wc -c < "$1")
  nonul=$(tr -d '\0' < "$1" | wc -c)
  [ "$size" -ne "$nonul" ]
}

: > "$TEXTLIST"
binaries=0
gitlinks=0
while IFS= read -r -d '' f; do
  # The one file the scan does not cover is this script, which has to name the
  # encodings it bans. Nothing checks the checker, so keep it free of the literal
  # character: it matches by codepoint and by encoding and never spells one out.
  if [ "$f" = 'scripts/check-no-emdash.sh' ]; then
    continue
  fi

  # `git ls-files` lists a submodule as a gitlink, which on disk is a REAL directory.
  # mllp has none today (checked: `git ls-files -s` lists no mode 160000 entry), but
  # keep the rule narrow so it cannot quietly grow into the `-d skip` hole: a real
  # directory is skipped, a SYMLINK to a directory is not, and falls through to the
  # not-a-regular-file refusal below.
  if [ -d "$f" ] && [ ! -L "$f" ]; then
    gitlinks=$((gitlinks + 1))
    continue
  fi

  if [ ! -r "$f" ]; then
    echo "ERROR: check-no-emdash - tracked file is not readable: $f" >&2
    echo "       Refusing to report green from a scan that could not open its input." >&2
    exit 1
  fi

  # Anything tracked that is not a regular file after symlink resolution (a symlink to
  # a directory, a symlink to nothing, a device) is refused by name rather than skipped.
  # Skipping is how `-d skip` let an UNREAD entry pass green, which is a missed read
  # rather than a missed match and is the harder one to notice.
  if [ ! -f "$f" ]; then
    echo "ERROR: check-no-emdash - tracked entry is not a regular file: $f" >&2
    echo "       Refusing to report green from a scan that skipped one of its inputs." >&2
    exit 1
  fi

  if has_nul "$f"; then
    binaries=$((binaries + 1))
    continue
  fi

  printf './%s\0' "$f" >> "$TEXTLIST"
done < "$FILELIST"

if [ ! -s "$TEXTLIST" ]; then
  echo "ERROR: check-no-emdash - no tracked TEXT files to scan. Refusing to report" >&2
  echo "       green from a scan that read nothing." >&2
  exit 1
fi

HITS=$(xargs -0 -r grep -H -nP -e "$PATTERN" -- < "$TEXTLIST" 2>>"$ERRLOG" || true)

refuse_if_incomplete

[ -n "$HITS" ] && fail_with_hits "the tracked files listed above" "$HITS"

echo "check-no-emdash: OK (no em dashes in the tracked text files; ${binaries} binary file(s) excluded by the NUL rule, ${gitlinks} gitlink(s) skipped, this script excluded)"
