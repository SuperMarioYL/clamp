# Build status and next steps

Clamp v0.1.0 is implemented and verified in this tree. This note records what is done,
how to publish it, and what deliberately remains out of scope.

## What is done

| Area | State |
| --- | --- |
| Source | `src/` — `cli`, `gitdelta`, `constraint`, `compile`, `validate`, `enforce`, `harness`, `store`, `model`, `proc` |
| Tests | 61 tests, all passing (`npm test`), on real temporary git repositories; git is never mocked |
| Build | `npm run build` → `dist/cli.js` plus the module graph, `bin` wired to `dist/cli.js` |
| Milestones | m1 snapshot/replay, m2 deterministic compile, m3 store gate, m4 hooks, m5 model assist |
| Docs | `README.md` (Chinese, primary), `README.en.md` (full translation), `CHANGELOG.md`, `VERSION`, `BUILD_SETUP_NEXT_STEPS.md` |
| Demo | `assets/demo.cast`, a 44-second asciinema v2 recording generated from a real run; `examples/replay-repo/` reproduces the smallest version |
| Release | `.github/workflows/release.yml`, tag-triggered: checks `VERSION`, runs tests, builds, `npm pack`, creates the release, uploads the tarball and `demo.cast` |
| CI | `.github/workflows/ci.yml`, Node 20 and 22 |

Verification commands, run in this tree:

```sh
npm run build
npm test          # 61 passed
```

The docs test (`tests/docs.test.ts`) treats the README as a contract: every `clamp`
command shown in a fenced block must appear in `clamp --help`, every local README link
must resolve, the two READMEs must stay in sync, and the cast must remain a valid,
roughly 45-second recording containing the real enforcement output.

## How to publish

1. **Create the repository.** Push this tree to `github.com/SuperMarioYL/clamp` on `main`.
   CI runs on the push; wait for it to go green.

2. **Check the identity fields.** `package.json` already carries `name: "clamp"`,
   `license: MIT`, `author: SuperMarioYL`, the repository URL and `homepage`. `LICENSE`
   must stay `Copyright (c) 2026 SuperMarioYL`. If the npm name is taken at publish time,
   change `name` here and the install lines in both READMEs together — nothing else reads it.

3. **Tag the release.** The tag must match the `VERSION` file, or the workflow fails
   before packing:

   ```sh
   git tag -a v0.1.0 -m "Clamp v0.1.0"
   git push origin main --tags
   ```

   The release workflow then runs the tests, builds `dist/`, runs `npm pack`
   (`clamp-0.1.0.tgz`), creates the GitHub release for the tag, and uploads the tarball
   and `assets/demo.cast` with `gh release upload`. It does not publish to npm and does
   not use workflow artifacts only.

4. **Publish to npm.** Kept manual on purpose, so a tag does not publish an accidental
   package. From a clean checkout of the tag:

   ```sh
   npm ci
   npm publish          # requires npm login / 2FA on the owning account
   npx clamp@0.1.0 --version
   ```

   If you later want it automated, add an `NPM_TOKEN` secret and an `npm publish --provenance`
   step after the pack step; do not remove the tarball upload.

5. **Verify the public install path.** In a scratch repository:

   ```sh
   npx clamp init
   npx clamp --help
   ```

   Then repeat the [quickstart](README.md#快速开始) once and confirm the commit is
   blocked with exit 2.

## Regenerating the demo cast

The cast was produced by running the built CLI in a temporary git repository with a
40-commit history, capturing real stdout/stderr for `init`, `fix`, `compile` (through a
pty, answering `y`), the blocked `git commit`, and `clamp hook pre-tool-use`, then
serialising those blocks as asciinema v2 events at roughly 45 seconds. No output in the
cast is hand-written. If CLI output changes, re-record rather than edit the cast, and
rerun `npm test` — the docs test checks the cast's duration and key lines.

## Out of scope for this version

These are decisions from the product plan, not missing work:

- AST triggers (tree-sitter); v0.1 ships `span` and `path` only.
- Automatic code changes, automatic agent re-runs, automatic repair of blocked patches.
- LLM-as-judge; checks read exit codes only, models only propose candidates.
- Conflict resolution or automatic merging; conflicts are reported side by side.
- Cross-repository sync, a hosted team registry, audit backend, accounts, billing.
- Web UI, plugin marketplace, IDE panels.
- Native Windows shells (macOS/Linux/WSL only); Codex private hooks (git pre-commit is the
  general fallback).
- Publishing a Gitee mirror; the clone entry point can be added without code changes.
