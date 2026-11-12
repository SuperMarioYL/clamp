#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  GitError,
  addedLines,
  emptyTree,
  repoRoot,
  snapshotWorktree,
} from "./gitdelta.js";
import { ConstraintError, type Constraint } from "./constraint.js";
import {
  CompileError,
  composeCandidate,
  deriveTemplate,
  formatDiff,
  labelForPattern,
  loadSnapshot,
  snapshotDiff,
  type TemplateDerivation,
} from "./compile.js";
import { describeTreeViolation, runTreeChecks } from "./enforce.js";
import {
  HarnessError,
  evaluatePreToolUse,
  installPreCommitHook,
  parsePreToolUseEvent,
  repoRelative,
  settingsSnippet,
} from "./harness.js";
import { modelConfigFromEnv, suggestCandidate } from "./model.js";
import {
  initStore,
  listConstraints,
  readConstraint,
  snapshotCommitMessage,
  snapshotRef,
} from "./store.js";
import {
  GateError,
  describeHit,
  gateCandidate,
  replayConstraint,
  storeGatedCandidate,
  type GateDecision,
} from "./validate.js";

const USAGE = `clamp — compile a human correction into a check that keeps running

usage:
  clamp init                     create .clamp/ and install the git pre-commit gate
  clamp fix [--words "..."]      snapshot the worktree (untracked files included)
  clamp compile <snapshot>       compile a candidate check and replay it three ways
        [--words "..."] [--model] [--yes] [--force] [--baseline N]
  clamp replay <constraint>      replay a stored constraint against bad, good and history
  clamp check [--staged]         run every tree_check against the worktree or the index
  clamp list                     list stored constraints
  clamp hook pre-commit          run tree_check (git pre-commit)
  clamp hook pre-tool-use        run content_check on the event's proposed text (stdin)
  clamp --version`;

type Command =
  | "init"
  | "fix"
  | "compile"
  | "replay"
  | "check"
  | "list"
  | "hook"
  | "help"
  | "version";

const KNOWN: Record<string, Command> = {
  init: "init",
  fix: "fix",
  compile: "compile",
  replay: "replay",
  check: "check",
  list: "list",
  hook: "hook",
  "--help": "help",
  "-h": "help",
  help: "help",
  "--version": "version",
  "-v": "version",
};

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  const command: Command | null = first === undefined ? "help" : (KNOWN[first] ?? null);
  switch (command) {
    case "help":
      console.log(USAGE);
      return first === undefined ? 1 : 0;
    case "version":
      console.log(`clamp v${await packageVersion()}`);
      return 0;
    case "init":
      return initCommand();
    case "fix":
      return fixCommand(rest);
    case "compile":
      return compileCommand(rest);
    case "replay":
      return replayCommand(rest);
    case "check":
      return checkCommand(rest);
    case "list":
      return listCommand();
    case "hook":
      return hookCommand(rest);
    case null:
      console.error(`clamp: unknown command "${first ?? ""}"\n`);
      console.error(USAGE);
      return 1;
  }
}

async function initCommand(): Promise<number> {
  const root = await repoRoot(process.cwd());
  await initStore(root);
  console.log(`Clamp v${await packageVersion()} · wrote .clamp/`);
  const hook = await installPreCommitHook(root, clampInvocation());
  console.log(
    `pre-commit  ${hook.path}${hook.chained ? " (previous hook kept as pre-commit.clamp-prev)" : ""}`,
  );
  console.log("Claude Code  add this to settings.json so writes are checked before they happen:");
  console.log(settingsSnippet());
  return 0;
}

/**
 * The exact command that runs this CLI right now, recorded into the hook so a later
 * shell without `clamp` on PATH still enforces the gate. A `.js` entry point needs the
 * current node binary; anything else (a linked bin) is invoked directly.
 */
function clampInvocation(): string {
  const entry = process.argv[1] ?? "";
  if (!entry) return "";
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const entryPath = entry.startsWith("/") ? entry : resolve(process.cwd(), entry);
  if (/\.(m?js|cjs)$/.test(entryPath)) {
    return `${quote(process.execPath)} ${quote(entryPath)}`;
  }
  return quote(entryPath);
}

async function fixCommand(args: string[]): Promise<number> {
  const root = await repoRoot(process.cwd());
  const words = optionValue(args, "--words") ?? "";

  const snapshot = await snapshotWorktree(root, {
    refFor: snapshotRef,
    message: snapshotCommitMessage(words),
  });

  const from = snapshot.base ?? (await emptyTree(root));
  const added = await addedLines(root, from, snapshot.commit);
  console.log(`snapshot ${snapshot.ref} · ${count(added.length, "added line")}`);
  for (const line of added.slice(0, 5)) {
    console.log(`  ${line.path}:${line.line}  ${line.text.trim()}`);
  }
  if (added.length > 5) console.log(`  … ${added.length - 5} more`);
  console.log(`after fixing the code, run: clamp compile ${snapshot.id}`);
  return 0;
}

async function compileCommand(args: string[]): Promise<number> {
  const target = positionalArgs(args, ["--words", "--baseline"])[0];
  if (target === undefined) {
    console.error("clamp: compile needs a snapshot id, e.g. `clamp compile 7f3a`");
    console.error("       run `clamp fix --words \"...\"` while the bad code is in the worktree first");
    return 1;
  }
  const baselineCommits = baselineOption(args);
  if (baselineCommits === null) return 1;

  const root = await repoRoot(process.cwd());
  const snapshot = await loadSnapshot(root, target, optionValue(args, "--words"));
  const diff = await snapshotDiff(root, snapshot);
  const wantModel = args.includes("--model");
  const force = args.includes("--force");

  let derivation: TemplateDerivation | null = null;
  let decision: GateDecision | null = null;
  let rejected = "";
  try {
    derivation = deriveTemplate(diff);
    const candidate = await composeCandidate(root, snapshot, {
      pattern: derivation.pattern,
      glob: derivation.glob,
      label: derivation.label,
      model: "template",
    });
    printCandidate(candidate);
    decision = await gateCandidate(root, candidate, { baselineCommits });
    printGates(decision);
    if (!decision.ok) rejected = decision.failures.join("; ");
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    console.log(`template  ${error.message}`);
    rejected = error.message;
  }

  if (wantModel && (decision === null || !decision.ok)) {
    const model = await suggestCandidate(modelConfigFromEnv(process.env), {
      words: snapshot.words,
      diff: formatDiff(diff),
      rejected,
    });
    if (!model.ok) {
      console.log(`model     unavailable: ${model.reason}`);
      console.log(
        decision === null
          ? "model     no template candidate to keep"
          : "model     keeping the template candidate",
      );
    } else if (model.suggestion.glob === "" && derivation === null) {
      console.log("model     offered no file glob and the template has none; keeping the template candidate");
    } else {
      const glob = model.suggestion.glob === "" ? (derivation?.glob ?? "") : model.suggestion.glob;
      const candidate = await composeCandidate(root, snapshot, {
        pattern: model.suggestion.pattern,
        glob,
        label: derivation?.label ?? labelForPattern(model.suggestion.pattern),
        model: model.model,
        claim: model.suggestion.claim,
      });
      printCandidate(candidate);
      decision = await gateCandidate(root, candidate, { baselineCommits });
      printGates(decision);
    }
  }

  if (decision === null) {
    console.log("clamp: nothing written — no candidate to gate");
    return 1;
  }
  if (!decision.ok) {
    for (const failure of decision.failures) console.log(`refused   ${failure}`);
    if (force) {
      const forced = await storeGatedCandidate(root, decision, { force: true });
      if (forced !== null) {
        console.log(`forced    wrote ${relative(root, forced.path)} as warn, never as block`);
        return 0;
      }
    }
    console.log("clamp: nothing written — the candidate did not pass replay");
    return 2;
  }
  if (!(await confirmWrite(args.includes("--yes")))) {
    console.log("clamp: nothing written");
    return 1;
  }
  const stored = await storeGatedCandidate(root, decision);
  if (stored === null) {
    console.log("clamp: nothing written — the candidate did not pass replay");
    return 2;
  }
  console.log(`written   ${relative(root, stored.path)}`);
  return 0;
}

function printCandidate(candidate: Constraint): void {
  const trigger =
    candidate.trigger.kind === "span"
      ? `span  ${candidate.trigger.glob}  /${candidate.trigger.pattern}/`
      : `path  ${candidate.trigger.glob}`;
  console.log(`candidate ${candidate.id}  ${trigger}`);
  if (candidate.contentCheck !== null) {
    console.log(`content_check  /${candidate.contentCheck.pattern}/  (PreToolUse, before the write)`);
  }
  if (candidate.treeCheck !== null) {
    console.log(
      `tree_check     ${candidate.treeCheck.cmd}  (expect: ${candidate.treeCheck.expect}, ${candidate.treeCheck.timeoutSec}s)`,
    );
  }
}

function printGates(decision: GateDecision): void {
  const verdict = (name: string): string => {
    const gate = decision.gates.find((entry) => entry.gate === name);
    if (gate === undefined) return "not run";
    return gate.ok ? "yes" : "no ";
  };
  if (decision.replay === null) {
    const scope = decision.gates.find((entry) => entry.gate === "scope");
    console.log(`replay    not run (${scope?.detail ?? "scope"})`);
    return;
  }
  const baseline = decision.gates.find((entry) => entry.gate === "baseline");
  console.log(
    `replay    fires_on_bad ${verdict("fires_on_bad")} · passes_on_good ${verdict("passes_on_good")} · baseline ${baseline?.detail ?? ""}`,
  );
}

async function confirmWrite(yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log("clamp: not a terminal; re-run with --yes to write this constraint");
    return false;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("accept? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function replayCommand(args: string[]): Promise<number> {
  const target = positionalArgs(args, ["--baseline"])[0];
  if (target === undefined) {
    console.error("clamp: replay needs a constraint id or path\n");
    console.error(USAGE);
    return 1;
  }
  const baselineCommits = baselineOption(args);
  if (baselineCommits === null) return 1;

  const root = await repoRoot(process.cwd());
  const { constraint } = await readConstraint(root, target);
  const result = await replayConstraint(root, constraint, { baselineCommits });

  console.log(`constraint ${constraint.id}  version ${constraint.version}  ${constraint.enforcement}`);
  console.log(`fires_on_bad    ${yesNo(result.firesOnBad)}${hitsNote(result.badHits)}`);
  console.log(`passes_on_good  ${yesNo(result.passesOnGood)}${hitsNote(result.goodHits)}`);
  console.log(
    `baseline        ${count(result.baseline.commits, "commit")} · ${count(result.baseline.blocks, "block")} · ${count(result.baseline.hits, "trigger hit")}`,
  );
  if (result.ok) {
    console.log("verdict         pass");
    return 0;
  }
  console.log("verdict         fail");
  for (const failure of result.failures) console.log(`  - ${failure}`);
  return 2;
}

async function checkCommand(args: string[]): Promise<number> {
  const root = await repoRoot(process.cwd());
  const stored = await listConstraints(root);
  if (stored.length === 0) {
    console.log("no constraints in .clamp/constraints");
    return 0;
  }
  const constraints = stored.map((entry) => entry.constraint);
  const report = await runTreeChecks(root, constraints, { staged: args.includes("--staged") });
  if (report.note !== null) console.log(report.note);

  for (const violation of [...report.warned, ...report.blocked]) {
    for (const line of describeTreeViolation(violation)) console.log(line);
  }
  if (report.blocked.length > 0) {
    console.log(`clamp: ${report.blocked.length} constraint(s) blocked (exit 2)`);
    return 2;
  }
  if (report.warned.length === 0) {
    console.log(report.checked === 0 ? "ok · no tree checks to run" : `ok · ${count(report.checked, "tree check")} passed`);
  }
  return 0;
}

async function hookCommand(args: string[]): Promise<number> {
  const [event] = args;
  if (event === "pre-commit") return preCommitHook();
  if (event === "pre-tool-use") return preToolUseHook();
  console.error("clamp: hook expects `pre-commit` or `pre-tool-use`");
  return 1;
}

/**
 * PreToolUse fires before the write, so there is no diff: the check runs against the text
 * the tool is about to produce. Claude Code blocks the call when this exits 2.
 */
async function preToolUseHook(): Promise<number> {
  const raw = await readStdin();
  if (raw.trim() === "") {
    console.error("clamp: hook pre-tool-use expects the PreToolUse JSON on stdin; nothing checked");
    return 0;
  }
  const payload = parsePreToolUseEvent(raw);
  let root: string;
  try {
    root = await repoRoot(payload.cwd === "" ? process.cwd() : payload.cwd);
  } catch (error) {
    if (error instanceof GitError && error.code === "not_a_repo") return 0;
    throw error;
  }
  const stored = await listConstraints(root);
  if (stored.length === 0) return 0;
  const verdict = evaluatePreToolUse(
    stored.map((entry) => entry.constraint),
    { ...payload, filePath: await repoRelative(payload.filePath, root) },
  );
  if (verdict.message !== "") process.stderr.write(verdict.message);
  return verdict.code;
}

/** pre-commit fires after the write, so the check runs against the worktree. */
async function preCommitHook(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const stored = await listConstraints(root);
  if (stored.length === 0) return 0;
  const report = await runTreeChecks(root, stored.map((entry) => entry.constraint));
  const lines = [
    ...report.warned.flatMap(describeTreeViolation),
    ...report.blocked.flatMap(describeTreeViolation),
  ];
  if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
  if (report.blocked.length === 0) return 0;
  process.stderr.write(
    `clamp: blocked the commit (exit 2) — ${report.blocked.length} constraint(s) refused it.\nclamp: fix the offending lines, or run \`clamp fix --words "..."\` if the rule itself is wrong.\n`,
  );
  return 2;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function listCommand(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const stored = await listConstraints(root);
  if (stored.length === 0) {
    console.log("no constraints in .clamp/constraints");
    return 0;
  }
  for (const { constraint } of stored) {
    const trigger =
      constraint.trigger.kind === "span"
        ? `span ${constraint.trigger.glob} /${constraint.trigger.pattern}/`
        : `path ${constraint.trigger.glob}`;
    console.log(`${constraint.id}  ${constraint.enforcement}  ${trigger}  ${constraint.version}`);
  }
  return 0;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no ";
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

function hitsNote(hits: Array<{ path: string; line: number; text: string }>): string {
  const first = hits[0];
  if (first === undefined) return "";
  const suffix = hits.length === 1 ? "" : ` (+${hits.length - 1} more)`;
  return `  ${describeHit(first)}${suffix}`;
}

function baselineOption(args: string[]): number | null {
  const raw = optionValue(args, "--baseline");
  if (raw === undefined) return 40;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error("clamp: --baseline expects a positive number of commits");
    return null;
  }
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

/** Positional arguments, skipping flags and the values that belong to `valueOptions`. */
function positionalArgs(args: string[], valueOptions: string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (valueOptions.includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  return positional;
}

async function packageVersion(): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof raw === "object" && raw !== null) {
      const version = (raw as Record<string, unknown>)["version"];
      if (typeof version === "string") return version;
    }
  } catch {
    // fall through to the static fallback below
  }
  return "0.1.0";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (
      error instanceof GitError ||
      error instanceof ConstraintError ||
      error instanceof GateError ||
      error instanceof CompileError ||
      error instanceof HarnessError
    ) {
      console.error(`clamp: ${error.message}`);
    } else {
      console.error(`clamp: ${errorMessage(error)}`);
    }
    process.exit(1);
  });
