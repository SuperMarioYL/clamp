import assert from "node:assert/strict";
import { test } from "node:test";
import { runTreeCheck } from "../src/validate.js";
import {
  BAD_DIGEST,
  BAD_REPORT,
  GOOD_FORMAT,
  GOOD_REPORT,
  cleanup,
  commitAll,
  fixWorktree,
  git,
  makeBadScenario,
  makeRepo,
  runCli,
  writeFileAt,
  writeHandWrittenConstraint,
} from "./helpers.js";

const ID = "0001-no-raw-toisostring";

test("replay passes when the bad snapshot fires and the fixed worktree is clean", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const path = await writeHandWrittenConstraint(scenario.root, ID, { badRef: scenario.badRef });

    const run = runCli(scenario.root, ["replay", ID]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /fires_on_bad {4}yes {2}src\/digest\.ts:\d+/);
    assert.match(run.stdout, /passes_on_good {2}yes/);
    assert.match(run.stdout, /baseline {8}1 commit · 0 blocks · 0 trigger hits/);
    assert.match(run.stdout, /verdict {9}pass/);

    // The same constraint can be addressed by file path.
    const byPath = runCli(scenario.root, ["replay", path]);
    assert.equal(byPath.status, 0, byPath.stderr);
  } finally {
    await cleanup(scenario.root);
  }
});

test("replay fails while the worktree still carries the offender", async () => {
  const scenario = await makeBadScenario();
  try {
    await writeHandWrittenConstraint(scenario.root, ID, { badRef: scenario.badRef });

    const run = runCli(scenario.root, ["replay", ID]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /passes_on_good {2}no/);
    assert.match(run.stdout, /verdict {9}fail/);
    assert.match(run.stdout, /passes_on_good: tree_check/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("replay rejects an over-narrow trigger that never fires on the bad snapshot", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    await writeHandWrittenConstraint(scenario.root, ID, {
      badRef: scenario.badRef,
      pattern: "toIsoStrng",
    });

    const run = runCli(scenario.root, ["replay", ID]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /fires_on_bad {4}no/);
    assert.match(run.stdout, /fires_on_bad: the trigger matches none/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("replay rejects an over-broad trigger that also matches the fixed lines", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    await writeHandWrittenConstraint(scenario.root, ID, { badRef: scenario.badRef, pattern: "\\." });

    const run = runCli(scenario.root, ["replay", ID]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /fires_on_bad {4}yes/);
    assert.match(run.stdout, /passes_on_good {2}no/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("baseline blocks a constraint that would have rejected existing history", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "good report");
    await writeFileAt(root, "src/report.ts", BAD_REPORT);
    await commitAll(root, "report regressed");
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "report fixed");

    // Record a fresh bad state on top of a clean HEAD, then fix the worktree.
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const fix = runCli(root, ["fix", "--words", "时间别自己拼"]);
    assert.equal(fix.status, 0, fix.stderr);
    const badRef = /snapshot (refs\/clamp\/bad\/[0-9a-f]+)/.exec(fix.stdout)?.[1];
    assert.ok(badRef);
    await fixWorktree(root);

    await writeHandWrittenConstraint(root, ID, { badRef });

    const run = runCli(root, ["replay", ID]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /baseline {8}3 commits · 1 block ·/);
    assert.match(run.stdout, /baseline: 1 of 3 recent commits/);
  } finally {
    await cleanup(root);
  }
});

test("check blocks a worktree violation and clears once the code is fixed", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    await writeHandWrittenConstraint(scenario.root, ID, { badRef: scenario.badRef });
    assert.equal(runCli(scenario.root, ["check"]).status, 0);

    await writeFileAt(scenario.root, "src/report.ts", BAD_REPORT);
    const blocked = runCli(scenario.root, ["check"]);
    assert.equal(blocked.status, 2, blocked.stdout);
    assert.match(blocked.stdout, /0001-no-raw-toisostring {2}blocked {2}src\/report\.ts:2/);
    assert.match(blocked.stdout, /check failed: git grep/);

    await fixWorktree(scenario.root);
    assert.equal(runCli(scenario.root, ["check"]).status, 0);
  } finally {
    await cleanup(scenario.root);
  }
});

test("check --staged reads the index even when the worktree was reverted", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    await writeHandWrittenConstraint(scenario.root, ID, { badRef: scenario.badRef });

    await writeFileAt(scenario.root, "src/report.ts", BAD_REPORT);
    git(scenario.root, ["add", "src/report.ts"]);
    await writeFileAt(scenario.root, "src/report.ts", GOOD_REPORT);

    assert.equal(runCli(scenario.root, ["check"]).status, 0, "the worktree itself is clean");
    const staged = runCli(scenario.root, ["check", "--staged"]);
    assert.equal(staged.status, 2, staged.stdout);
    assert.match(staged.stdout, /0001-no-raw-toisostring {2}blocked/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("an invalid regex makes the check an error, never a pass", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "base");

    const broken = await runTreeCheck(root, { cmd: "git grep -nE '([' -- .", timeoutSec: 10, expect: "no_match" });
    assert.equal(broken.code, 128);
    assert.equal(broken.verdict, "error");

    const negative = await runTreeCheck(root, {
      cmd: "git grep -nE 'toISOString' -- .",
      timeoutSec: 10,
      expect: "no_match",
    });
    assert.equal(negative.code, 1);
    assert.equal(negative.verdict, "pass");
  } finally {
    await cleanup(root);
  }
});
