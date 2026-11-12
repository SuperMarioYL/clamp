import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  GOOD_REPORT,
  cleanup,
  fixWorktree,
  git,
  makeBadScenario,
  runCli,
  writeFileAt,
} from "./helpers.js";

const CONSTRAINT = "0001-no-raw-toisostring";

test("compile derives trigger, content_check and tree_check from the diff and writes the file", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);

    const run = runCli(scenario.root, ["compile", scenario.badId, "--yes"]);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /candidate 0001-no-raw-toisostring {2}span {2}src\/\*\*\/\*\.ts {2}\/\\\.toISOString\\\(\\\)\//);
    assert.match(run.stdout, /content_check {2}\/\\\.toISOString\\\(\\\)\//);
    assert.match(
      run.stdout,
      /tree_check {5}git grep --untracked -nE '\\\.toISOString\\\(\\\)' -- ':\(glob\)src\/\*\*\/\*\.ts' {2}\(expect: no_match/,
    );
    assert.match(run.stdout, /replay {4}fires_on_bad yes · passes_on_good yes · baseline 1 commit · 0 blocks/);
    assert.match(run.stdout, /written {3}\.clamp\/constraints\/0001-no-raw-toisostring\.yaml/);

    const yaml = await readFile(join(scenario.root, ".clamp/constraints", `${CONSTRAINT}.yaml`), "utf8");
    assert.match(yaml, /^id: 0001-no-raw-toisostring$/m);
    assert.match(yaml, /claim: 时间别自己拼，统一用 formatDate/);
    assert.match(yaml, /expect: no_match/);
    assert.match(yaml, /bad_ref: refs\/clamp\/bad\//);
    assert.match(yaml, /base: [0-9a-f]{40}/);
    assert.match(yaml, /created_at: \d{4}-\d{2}-\d{2}T/);
    assert.match(yaml, /version: [0-9a-f]{12}/);

    // The stored constraint really does what it promises.
    assert.equal(runCli(scenario.root, ["check"]).status, 0);
    const replay = runCli(scenario.root, ["replay", CONSTRAINT]);
    assert.equal(replay.status, 0, replay.stdout);
  } finally {
    await cleanup(scenario.root);
  }
});

test("compile numbers the next constraint and refuses without --yes when stdin is not a terminal", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    // Only the file name matters for numbering; compile never parses it.
    await writeFileAt(scenario.root, ".clamp/constraints/0007-existing.yaml", "id: 0007-existing\n");

    const refused = runCli(scenario.root, ["compile", scenario.badId]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /re-run with --yes/);
    assert.match(refused.stdout, /candidate 0008-no-raw-toisostring/);

    const accepted = runCli(scenario.root, ["compile", scenario.badId, "--yes"]);
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.match(accepted.stdout, /written {3}\.clamp\/constraints\/0008-no-raw-toisostring\.yaml/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("compile refuses a diff it cannot derive a check from and writes nothing", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    git(scenario.root, ["add", "-A"]);
    git(scenario.root, ["commit", "-q", "-m", "fix the digest"]);

    // A comment-only change: no literal, no call, nothing to grep for.
    await writeFileAt(scenario.root, "src/report.ts", `${GOOD_REPORT}// tweak\n`);
    const fix = runCli(scenario.root, ["fix", "--words", "说明一下"]);
    assert.equal(fix.status, 0, fix.stderr);
    const id = /snapshot refs\/clamp\/bad\/([0-9a-f]+)/.exec(fix.stdout)?.[1];
    assert.ok(id);

    const run = runCli(scenario.root, ["compile", id, "--yes"]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /cannot derive a check from this diff/);
    assert.match(run.stdout, /--model/);
    assert.match(run.stdout, /nothing written/);

    const list = runCli(scenario.root, ["list"]);
    assert.match(list.stdout, /no constraints/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("compile explains an unknown snapshot instead of guessing", async () => {
  const scenario = await makeBadScenario();
  try {
    const run = runCli(scenario.root, ["compile", "deadbeef", "--yes"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no snapshot at refs\/clamp\/bad\/deadbeef/);
    assert.match(run.stderr, /clamp fix/);
  } finally {
    await cleanup(scenario.root);
  }
});
