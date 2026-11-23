# mend: one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/manzcyber/makefun-mend-cli/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/manzcyber/makefun-mend-cli/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` is
the whole specification. See the [bounty on make.fun](https://make.fun/c/hidden-spec-cli-01-run-20261122).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It reads unified
  diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, matches lines at three tiers, and writes every change or
  none. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each
  one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared,
so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank
context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final
line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice
set does not.
