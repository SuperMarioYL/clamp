import {
  addedLines,
  changedFiles,
  commitTree,
  createCommit,
  emptyTree,
  headCommit,
  parentCommit,
  recentCommits,
  resolveCommit,
  withCommitWorktree,
  worktreeTree,
  writeIndexTree,
} from "./gitdelta.js";
import { compilePattern, expectVerdict, globSelectsWholeDirectory, type CheckVerdict, type Constraint, type TreeCheck } from "./constraint.js";
import { runProcess } from "./proc.js";
import { writeConstraint } from "./store.js";

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

export type CheckResult = {
  verdict: CheckVerdict;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Run one tree_check command and turn its exit code into a verdict. */
export async function runTreeCheck(cwd: string, check: TreeCheck): Promise<CheckResult> {
  const result = await runProcess(check.cmd, [], {
    cwd,
    shell: true,
    timeoutMs: Math.max(1, check.timeoutSec) * 1000,
  });
  const verdict: CheckVerdict =
    result.timedOut || result.spawnError !== null ? "error" : expectVerdict(check.expect, result.code);
  return {
    verdict,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export type TriggerHit = { path: string; line: number; text: string };

/**
 * Where a trigger fires between two trees. A span trigger looks only at added lines, so
 * rewrites that remove the offending code never count as hits; a path trigger counts
 * every touched file in scope.
 */
export async function findTriggerHits(
  root: string,
  constraint: Constraint,
  from: string,
  to: string,
): Promise<TriggerHit[]> {
  const trigger = constraint.trigger;
  if (trigger.kind === "path") {
    const files = await changedFiles(root, from, to, trigger.glob);
    return files.map((file) => ({ path: file.path, line: 0, text: file.status }));
  }
  const pattern = compilePattern(trigger.pattern);
  const lines = await addedLines(root, from, to, trigger.glob);
  return lines.filter((line) => pattern.test(line.text));
}

export type ReplayBaseline = { commits: number; blocks: number; hits: number };

export type ReplayResult = {
  constraintId: string;
  badRef: string;
  firesOnBad: boolean;
  passesOnGood: boolean;
  baseline: ReplayBaseline;
  ok: boolean;
  badHits: TriggerHit[];
  goodHits: TriggerHit[];
  failures: string[];
};

export type ReplayOptions = {
  /** How many recent commits the baseline replays. The gate default is 40. */
  baselineCommits?: number;
};

/**
 * Replay a constraint against the recorded bad snapshot and the current (fixed) worktree.
 *
 * All three gates must hold before a constraint may be stored:
 *   1. fires_on_bad  — the trigger sees the offending line in the bad snapshot;
 *   2. passes_on_good — neither the trigger nor the tree_check objects to the fixed worktree;
 *   3. baseline       — the last N commits all satisfy the tree_check.
 */
export async function replayConstraint(
  root: string,
  constraint: Constraint,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const badRef = constraint.provenance.badRef;
  if (badRef === "") throw new GateError(`constraint ${constraint.id} has no provenance.bad_ref`);
  const badCommit = await resolveCommit(root, badRef);
  if (badCommit === null) throw new GateError(`bad ref not found: ${badRef}`);

  const base = await resolveBase(root, badCommit);
  const badHits = await findTriggerHits(root, constraint, base, badCommit);
  const goodTree = (await worktreeTree(root)).tree;
  const goodHits = await findTriggerHits(root, constraint, base, goodTree);

  const failures: string[] = [];
  const firesOnBad = badHits.length > 0;
  if (!firesOnBad) {
    failures.push(`fires_on_bad: the trigger matches none of the lines added in ${badRef}`);
  }

  let passesOnGood = goodHits.length === 0;
  if (!passesOnGood) {
    failures.push(`passes_on_good: the trigger still matches the fixed worktree (${describeHit(goodHits[0])})`);
  }
  const treeCheck = constraint.treeCheck;
  if (treeCheck !== null) {
    const result = await runTreeCheck(root, treeCheck);
    if (result.verdict !== "pass") {
      passesOnGood = false;
      failures.push(`passes_on_good: tree_check ${describeCheck(result)} on the fixed worktree`);
    }
  }

  const baseline = await runBaseline(root, constraint, options.baselineCommits ?? 40);
  if (baseline.blocks > 0) {
    failures.push(
      `baseline: ${baseline.blocks} of ${baseline.commits} recent commits violate the tree_check`,
    );
  }

  return {
    constraintId: constraint.id,
    badRef,
    firesOnBad,
    passesOnGood,
    baseline,
    ok: firesOnBad && passesOnGood && baseline.blocks === 0,
    badHits,
    goodHits,
    failures,
  };
}

/**
 * The snapshot commit's first parent is the honest diff base: it is the state the bad
 * change was made on top of, even if HEAD has moved on since `clamp fix`.
 */
async function resolveBase(root: string, badCommit: string): Promise<string> {
  return (await parentCommit(root, badCommit)) ?? (await emptyTree(root));
}

async function runBaseline(root: string, constraint: Constraint, limit: number): Promise<ReplayBaseline> {
  const commits = await recentCommits(root, limit);
  const empty = await emptyTree(root);
  const treeCheck = constraint.treeCheck;
  let blocks = 0;
  let hits = 0;
  for (const commit of commits) {
    const parent = commit.parents[0] ?? empty;
    const commitHits = await findTriggerHits(root, constraint, parent, commit.rev);
    if (commitHits.length > 0) hits += 1;
    if (treeCheck !== null) {
      const result = await withCommitWorktree(root, commit.rev, (dir) => runTreeCheck(dir, treeCheck));
      if (result.verdict !== "pass") blocks += 1;
    }
  }
  return { commits: commits.length, blocks, hits };
}

export type GateName = "scope" | "fires_on_bad" | "passes_on_good" | "baseline";

export type GateResult = {
  gate: GateName;
  ok: boolean;
  detail: string;
};

export type GateDecision = {
  candidate: Constraint;
  gates: GateResult[];
  replay: ReplayResult | null;
  ok: boolean;
  failures: string[];
};

export type GateOptions = {
  baselineCommits?: number;
};

/**
 * Evaluate a candidate against every gate.
 *
 * `scope` is checked first: a trigger glob that names a whole directory cannot say which
 * changes deserve the check. The three replay gates then run against the recorded bad
 * snapshot, the fixed worktree and the last N commits. Nothing is written here; see
 * storeGatedCandidate.
 */
export async function gateCandidate(
  root: string,
  candidate: Constraint,
  options: GateOptions = {},
): Promise<GateDecision> {
  const gates: GateResult[] = [scopeGate(candidate)];
  let replay: ReplayResult | null = null;
  if (gates[0]?.ok === true) {
    replay = await replayConstraint(root, candidate, {
      baselineCommits: options.baselineCommits ?? 40,
    });
    gates.push(
      {
        gate: "fires_on_bad",
        ok: replay.firesOnBad,
        detail: replay.firesOnBad
          ? describeHit(replay.badHits[0])
          : `the trigger matches none of the lines added in ${replay.badRef}`,
      },
      {
        gate: "passes_on_good",
        ok: replay.passesOnGood,
        detail: replay.passesOnGood
          ? "the fixed worktree is clean"
          : `the fixed worktree still violates the check (${describeHit(replay.goodHits[0])})`,
      },
      {
        gate: "baseline",
        ok: replay.baseline.blocks === 0,
        detail: `${plural(replay.baseline.commits, "commit")} · ${plural(replay.baseline.blocks, "block")} · ${plural(replay.baseline.hits, "trigger hit")}`,
      },
    );
  }
  const failures = gates.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`);
  return { candidate, gates, replay, ok: failures.length === 0, failures };
}

/**
 * Write a gated candidate. This is the only function that puts a constraint in the store,
 * and it refuses any decision the gates did not pass. `force` may downgrade a candidate
 * that failed replay to `warn`; it can never store it as `block`.
 */
export async function storeGatedCandidate(
  root: string,
  decision: GateDecision,
  options: { force?: boolean } = {},
): Promise<{ constraint: Constraint; path: string } | null> {
  if (decision.ok) return writeConstraint(root, decision.candidate);
  if (options.force === true && decision.replay !== null) {
    return writeConstraint(root, { ...decision.candidate, enforcement: "warn" });
  }
  return null;
}

function scopeGate(candidate: Constraint): GateResult {
  const glob = candidate.trigger.glob;
  if (globSelectsWholeDirectory(glob)) {
    return {
      gate: "scope",
      ok: false,
      detail: `trigger glob "${glob}" names a whole directory; name a kind of file instead (e.g. "src/**/*.ts")`,
    };
  }
  return { gate: "scope", ok: true, detail: glob };
}

export type Violation = {
  constraint: Constraint;
  check: TreeCheck;
  result: CheckResult;
  /** First file:line reported by the failed command, when it reports one. */
  evidence: string | null;
};

export type CheckReport = {
  blocked: Violation[];
  warned: Violation[];
  /** How many constraints actually carried a tree_check to run. */
  checked: number;
  note: string | null;
};

/** Run every tree_check against the current worktree. */
export async function checkWorktree(root: string, constraints: Constraint[]): Promise<CheckReport> {
  return runChecksIn(root, constraints, null);
}

/**
 * Run every tree_check against what `git commit` would record right now. The index is
 * materialised as a temporary commit so the check sees exactly the staged content,
 * not whatever happens to be left in the worktree.
 */
export async function checkIndex(root: string, constraints: Constraint[]): Promise<CheckReport> {
  const indexTree = await writeIndexTree(root);
  if (indexTree === (await emptyTree(root))) {
    return { blocked: [], warned: [], checked: 0, note: "nothing staged" };
  }
  const head = await headCommit(root);
  if (head !== null && (await commitTree(root, head)) === indexTree) {
    return { blocked: [], warned: [], checked: 0, note: "staged tree matches HEAD" };
  }
  const commit = await createCommit(root, indexTree, "clamp staged check");
  return withCommitWorktree(root, commit, (dir) => runChecksIn(dir, constraints, null));
}

async function runChecksIn(
  cwd: string,
  constraints: Constraint[],
  note: string | null,
): Promise<CheckReport> {
  const blocked: Violation[] = [];
  const warned: Violation[] = [];
  let checked = 0;
  for (const constraint of constraints) {
    const check = constraint.treeCheck;
    if (check === null) continue;
    checked += 1;
    const result = await runTreeCheck(cwd, check);
    if (result.verdict === "pass") continue;
    const violation: Violation = { constraint, check, result, evidence: firstEvidence(result) };
    if (constraint.enforcement === "block") blocked.push(violation);
    else warned.push(violation);
  }
  return { blocked, warned, checked, note };
}

/** `1 commit` / `40 commits`, so gate details read as sentences. */
function plural(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

export function describeHit(hit: TriggerHit | undefined): string {
  if (hit === undefined) return "unknown location";
  return hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path;
}

export function describeCheck(result: CheckResult): string {
  if (result.timedOut) return "timed out";
  if (result.code === null) return "did not run";
  return `expect violation, exit ${result.code}`;
}

function firstEvidence(result: CheckResult): string | null {
  const match = result.stdout.split("\n").find((line) => /^[^\s:][^:]*:\d+:/.test(line));
  if (match !== undefined) return match.trim();
  const first = result.stdout.split("\n").find((line) => line.trim() !== "");
  if (first !== undefined) return first.trim();
  const err = result.stderr.split("\n").find((line) => line.trim() !== "");
  return err === undefined ? null : err.trim();
}
