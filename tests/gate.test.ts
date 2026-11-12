import assert from "node:assert/strict";
import { test } from "node:test";
import { withVersion, type Constraint, type Trigger } from "../src/constraint.js";
import { gateCandidate, storeGatedCandidate } from "../src/validate.js";
import { listConstraints } from "../src/store.js";
import {
  BAD_DIGEST,
  BAD_REPORT,
  GOOD_FORMAT,
  GOOD_REPORT,
  cleanup,
  commitAll,
  fixWorktree,
  makeBadScenario,
  makeRepo,
  runCli,
  writeFileAt,
} from "./helpers.js";

function candidate(
  badRef: string,
  pattern: string,
  glob = "src/**/*.ts",
  id = "0001-candidate",
): Constraint {
  const trigger: Trigger = { kind: "span", glob, pattern };
  return withVersion({
    id,
    claim: "时间别自己拼，统一用 formatDate",
    trigger,
    contentCheck: { pattern },
    treeCheck: {
      cmd: `git grep --untracked -nE '${pattern}' -- ':(glob)${glob}'`,
      timeoutSec: 20,
      expect: "no_match",
    },
    enforcement: "block",
    provenance: {
      badRef,
      goodRef: "worktree",
      words: "时间别自己拼，统一用 formatDate",
      model: "template",
      base: "",
      createdAt: "",
    },
    version: "",
  });
}

test("the scope gate refuses a trigger that selects a whole directory", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const decision = await gateCandidate(scenario.root, candidate(scenario.badRef, "toISOString", "src/**"));

    assert.equal(decision.ok, false);
    assert.equal(decision.gates[0]?.gate, "scope");
    assert.equal(decision.gates[0]?.ok, false);
    assert.match(decision.failures[0] ?? "", /^scope: trigger glob "src\/\*\*" names a whole directory/);
    // Nothing was replayed, so the expensive gates were not wasted on a broken trigger.
    assert.equal(decision.replay, null);
  } finally {
    await cleanup(scenario.root);
  }
});

test("an over-broad regex is refused by passes_on_good", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const decision = await gateCandidate(scenario.root, candidate(scenario.badRef, "\\."));

    assert.equal(decision.ok, false);
    const failed = decision.gates.filter((gate) => !gate.ok).map((gate) => gate.gate);
    assert.ok(failed.includes("passes_on_good"), failed.join(","));
    assert.ok(
      decision.failures.some((failure) => failure.startsWith("passes_on_good: ")),
      decision.failures.join("; "),
    );
  } finally {
    await cleanup(scenario.root);
  }
});

test("a misspelled pattern is refused by fires_on_bad", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const decision = await gateCandidate(scenario.root, candidate(scenario.badRef, "toIsoStrng"));

    assert.equal(decision.ok, false);
    assert.deepEqual(
      decision.gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
      ["fires_on_bad"],
    );
    assert.match(decision.failures[0] ?? "", /^fires_on_bad: /);
  } finally {
    await cleanup(scenario.root);
  }
});

test("the baseline samples the requested commits and names the ones that would be blocked", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "good report");
    await writeFileAt(root, "src/report.ts", BAD_REPORT);
    await commitAll(root, "report regressed");
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "report fixed");

    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const fix = runCli(root, ["fix", "--words", "时间别自己拼"]);
    assert.equal(fix.status, 0, fix.stderr);
    const badRef = /snapshot (refs\/clamp\/bad\/[0-9a-f]+)/.exec(fix.stdout)?.[1];
    assert.ok(badRef);
    await fixWorktree(root);

    // History alone rejects it: one of the three commits still calls toISOString.
    const rejected = await gateCandidate(root, candidate(badRef, "\\.toISOString\\(\\)"));
    const baseline = rejected.replay?.baseline;
    assert.equal(baseline?.commits, 3);
    assert.equal(baseline?.blocks, 1);
    assert.deepEqual(
      rejected.gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
      ["baseline"],
    );

    // A pattern that history does not contradict passes, and only the last 2 commits are sampled.
    const narrowlyScoped = await gateCandidate(root, candidate(badRef, "toISOString", "src/digest.ts"), {
      baselineCommits: 2,
    });
    assert.equal(narrowlyScoped.replay?.baseline.commits, 2);
  } finally {
    await cleanup(root);
  }
});

test("storeGatedCandidate refuses a failing decision, and --force can only write warn", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const failing = await gateCandidate(scenario.root, candidate(scenario.badRef, "toIsoStrng"));
    assert.equal(failing.ok, false);

    assert.equal(await storeGatedCandidate(scenario.root, failing), null);
    assert.deepEqual(await listConstraints(scenario.root), []);

    const forced = await storeGatedCandidate(scenario.root, failing, { force: true });
    assert.ok(forced);
    assert.equal(forced.constraint.enforcement, "warn");
    const stored = await listConstraints(scenario.root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.constraint.enforcement, "warn");
  } finally {
    await cleanup(scenario.root);
  }
});

test("clamp compile --force downgrades a rejected candidate to warn", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "good report");
    await writeFileAt(root, "src/report.ts", BAD_REPORT);
    await commitAll(root, "report regressed");
    await writeFileAt(root, "src/report.ts", GOOD_REPORT);
    await commitAll(root, "report fixed");

    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const fix = runCli(root, ["fix", "--words", "时间别自己拼"]);
    const id = /snapshot refs\/clamp\/bad\/([0-9a-f]+)/.exec(fix.stdout)?.[1];
    assert.ok(id);
    await fixWorktree(root);

    const refused = runCli(root, ["compile", id, "--yes"]);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stdout, /refused {3}baseline: 3 commits · 1 block · 1 trigger hit/);
    assert.match(refused.stdout, /nothing written/);
    assert.match(runCli(root, ["list"]).stdout, /no constraints/);

    const forced = runCli(root, ["compile", id, "--yes", "--force"]);
    assert.equal(forced.status, 0, forced.stdout);
    assert.match(forced.stdout, /forced {4}wrote \.clamp\/constraints\/0001-no-raw-toisostring\.yaml as warn/);
    assert.match(runCli(root, ["list"]).stdout, /0001-no-raw-toisostring {2}warn/);
  } finally {
    await cleanup(root);
  }
});
