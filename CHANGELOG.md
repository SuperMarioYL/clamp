# Changelog

Notable changes to Clamp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-12

First release: one human correction becomes a check that runs before an agent write and
before a commit.

### Snapshot and replay (`m1_snapshot_replay`)

- `clamp fix` records the whole worktree, untracked files included, with a temporary index
  (`GIT_INDEX_FILE` + `git add -A` + `git write-tree` + `git commit-tree`) and points
  `refs/clamp/bad/<id>` at it. The worktree, the index and `HEAD` are left alone.
- An unchanged worktree, or one whose tree equals `HEAD`, exits non-zero and writes no ref,
  so a later replay can never be based on an empty snapshot.
- The correction words travel in the snapshot commit message; `clamp compile --words`
  overrides them for a single run.
- `clamp replay <constraint>` prints `fires_on_bad`, `passes_on_good` and the baseline, and
  exits 2 when any gate fails.

### Deterministic compile (`m2_template_compile`)

- `clamp compile <snapshot>` derives a span trigger from the lines the bad snapshot adds:
  a method call or a literal that appears in the added lines and not in the removed ones.
- The same claim becomes two checks: `content_check` (the regex) and `tree_check`
  (`git grep --untracked -nE … -- ':(glob)src/**/*.ts'`, `expect: no_match`).
- The constraint is written to `.clamp/constraints/<NNNN>-<slug>.yaml` with provenance and
  a content-derived `version`.

### Store gate (`m3_replay_gate`)

- `validate.ts` is the only path to disk: `fires_on_bad`, `passes_on_good` and
  `baseline_blocks === 0` must all hold.
- A scope gate rejects triggers that name a whole directory (`src/**`); the baseline samples
  40 commits by default and replays the `tree_check` against each one.
- Exit codes are explicit: `expect: match` passes on 0, `expect: no_match` passes on 1, and
  128, any other code, a timeout or a spawn failure is a check error and fails closed.
- `--force` may store a failed candidate as `warn`; it can never store it as `block`.

### Enforcement (`m4_enforce_hooks`)

- `clamp init` installs `pre-commit` into `git rev-parse --git-path hooks`, so
  `core.hooksPath` and linked worktrees work. An existing hook is kept as
  `pre-commit.clamp-prev` and runs first.
- `clamp hook pre-tool-use` reads the Claude Code `PreToolUse` event from stdin and applies
  `content_check` to `tool_input.content` (Write) or `tool_input.new_string` (Edit); a
  `block` hit exits 2 and stops the write.
- `clamp check [--staged]` runs every `tree_check` against the worktree, or against the
  index materialised as a temporary commit. `warn` constraints print but never block.

### Optional model assist (`m5_model_assist`)

- `clamp compile --model` asks DeepSeek, Qwen, GLM or a self-hosted vLLM through an
  OpenAI-compatible endpoint (`CLAMP_BASE_URL`, `CLAMP_MODEL`, `CLAMP_MODEL_API_KEY`) for a
  candidate after the template has failed or been refused.
- Model candidates replay through the same gates. An unreachable endpoint falls back to the
  template and prints the reason.

### Documentation and distribution

- Chinese README with a complete English translation, cross-linked at the top.
- `assets/demo.cast`, a 44-second asciinema v2 recording of the full loop, generated from a
  real run against a 40-commit repository.
- `examples/replay-repo/`, the smallest reproduction of the recorded mistake.
- A tag-triggered release workflow that checks `VERSION`, runs the tests, packs the npm
  tarball and uploads it together with `assets/demo.cast` as release assets.
