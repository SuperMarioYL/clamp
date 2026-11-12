import { compilePattern, globMatchesPath, type Constraint } from "./constraint.js";
import { checkIndex, checkWorktree, type CheckReport, type Violation } from "./validate.js";

/**
 * The two execution surfaces, and the only two.
 *
 * `PreToolUse` runs before a write, so the only evidence is the proposed text (Write's
 * `content`, Edit's `new_string`) — `checkContent` matches `content_check` against it.
 * `pre-commit` runs after the write, so `runTreeChecks` points `tree_check` at the
 * worktree. Both express the same claim; neither can be reduced to the other.
 */

export type ProposedWrite = {
  /** The file the tool is about to write. */
  filePath: string;
  /** Whole file (Write) or the replacement fragment (Edit). */
  text: string;
};

export type ContentViolation = {
  constraint: Constraint;
  filePath: string;
  pattern: string;
  /** 1-based line inside `text`, which is the real line only for a whole-file write. */
  line: number;
  sample: string;
};

/**
 * Apply every constraint's `content_check` to a proposed write. The trigger only decides
 * whether a constraint is worth running here; the check decides pass or fail.
 */
export function checkContent(constraints: Constraint[], write: ProposedWrite): ContentViolation[] {
  const violations: ContentViolation[] = [];
  for (const constraint of constraints) {
    const check = constraint.contentCheck;
    if (check === null) continue;
    if (!globMatchesPath(constraint.trigger.glob, write.filePath)) continue;

    const pattern = compilePattern(check.pattern);
    const match = pattern.exec(write.text);
    if (match === null) continue;
    violations.push({
      constraint,
      filePath: write.filePath,
      pattern: check.pattern,
      line: lineAt(write.text, match.index),
      sample: trim(containingLine(write.text, match.index), 160),
    });
  }
  return violations;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function containingLine(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? text.length : end);
}

function trim(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export type TreeCheckOptions = { staged?: boolean };

/** Run every `tree_check`: the worktree before a commit, or the index for `--staged`. */
export function runTreeChecks(
  root: string,
  constraints: Constraint[],
  options: TreeCheckOptions = {},
): Promise<CheckReport> {
  return options.staged === true ? checkIndex(root, constraints) : checkWorktree(root, constraints);
}

/** One line per violation, the shape both hooks print. */
export function describeContentViolation(violation: ContentViolation, withLine: boolean): string {
  const where = withLine ? `${violation.filePath}:${violation.line}` : violation.filePath;
  return `${violation.constraint.id}  ${where}  content_check /${violation.pattern}/ matched "${violation.sample}"`;
}

/** The two lines `clamp check` and the pre-commit hook print for a failed tree check. */
export function describeTreeViolation(violation: Violation): string[] {
  const state = violation.constraint.enforcement === "warn" ? "warn" : "blocked";
  return [
    `${violation.constraint.id}  ${state}  ${violation.evidence ?? "no output"}`,
    `  check failed: ${violation.check.cmd}`,
  ];
}
