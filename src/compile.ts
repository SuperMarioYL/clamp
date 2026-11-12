import { extname } from "node:path";
import {
  compilePattern,
  globSelectsWholeDirectory,
  withVersion,
  type Constraint,
  type Trigger,
} from "./constraint.js";
import {
  commitMessage,
  diffLines,
  emptyTree,
  gitPathspec,
  parentCommit,
  resolveCommit,
  type AddedLine,
  type DiffLines,
} from "./gitdelta.js";
import { nextConstraintId, snapshotRef, snapshotWordsFromMessage } from "./store.js";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/** The recorded bad state a candidate is compiled from. */
export type SnapshotTarget = {
  ref: string;
  commit: string;
  /** The tree the bad change was made on top of; the honest side of the diff. */
  base: string;
  words: string;
};

export async function loadSnapshot(
  root: string,
  idOrRef: string,
  wordsOption?: string,
): Promise<SnapshotTarget> {
  const ref = idOrRef.startsWith("refs/") ? idOrRef : snapshotRef(idOrRef);
  const commit = await resolveCommit(root, ref);
  if (commit === null) {
    throw new CompileError(
      `no snapshot at ${ref} — run \`clamp fix\` while the bad code is still in the worktree`,
    );
  }
  const base = (await parentCommit(root, commit)) ?? (await emptyTree(root));
  const words = wordsOption ?? snapshotWordsFromMessage(await commitMessage(root, commit));
  return { ref, commit, base, words };
}

type PatternCandidate = {
  pattern: string;
  /** Human name of the offending token, used for the constraint id and claim. */
  label: string;
  /** Higher wins: a method call is more specific than a bare name. */
  tier: number;
};

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "instanceof",
  "new",
  "delete",
  "void",
  "await",
  "yield",
  "function",
  "class",
  "import",
  "export",
  "const",
  "let",
  "var",
  "else",
  "do",
  "try",
  "finally",
  "throw",
]);

/**
 * Literals and calls an added line carries, in a deterministic rank order.
 *
 * A method call (`toISOString()`) is preferred over the receiver it is called on, because
 * the receiver is usually a local name (`d`, `ts`) that the next session will spell
 * differently; the literal is the fallback for corrections about a fixed string.
 */
function patternCandidates(lines: AddedLine[]): PatternCandidate[] {
  const found = new Map<string, PatternCandidate>();
  const add = (candidate: PatternCandidate): void => {
    const previous = found.get(candidate.pattern);
    if (previous === undefined || candidate.tier > previous.tier) found.set(candidate.pattern, candidate);
  };

  for (const line of lines) {
    for (const match of line.text.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      const index = match.index;
      if (name === undefined || index === undefined) continue;
      const emptyCall = /^\s*\)/.test(line.text.slice(index + match[0].length));
      add({
        pattern: emptyCall ? `\\.${name}\\(\\)` : `\\.${name}\\(`,
        label: name,
        tier: 3,
      });
    }
    for (const match of line.text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      const index = match.index;
      if (name === undefined || index === undefined || KEYWORDS.has(name)) continue;
      if (index > 0 && line.text[index - 1] === ".") continue;
      const emptyCall = /^\s*\)/.test(line.text.slice(index + match[0].length));
      add({
        pattern: emptyCall ? `\\b${name}\\(\\)` : `\\b${name}\\(`,
        label: name,
        tier: 1,
      });
    }
    for (const match of line.text.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)) {
      const literal = match[1];
      if (literal === undefined || !/[A-Za-z0-9]/.test(literal)) continue;
      add({ pattern: escapeRegExp(literal), label: literal, tier: 2 });
    }
  }

  return [...found.values()].sort(
    (left, right) =>
      right.tier - left.tier || right.pattern.length - left.pattern.length || left.pattern.localeCompare(right.pattern),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TemplateDerivation = {
  pattern: string;
  glob: string;
  label: string;
};

/**
 * Derive a span trigger and its file scope from the lines the bad snapshot adds.
 *
 * A candidate must match at least one added line and none of the removed lines: that is
 * the difference the human correction made, and it is what replay will check again.
 */
export function deriveTemplate(diff: DiffLines): TemplateDerivation {
  if (diff.added.length === 0) {
    throw new CompileError(
      "the snapshot adds no lines, so there is no offending code to compile — run `clamp fix` while the bad change is in the worktree",
    );
  }
  const rejected: string[] = [];
  for (const candidate of patternCandidates(diff.added)) {
    const regex = compilePattern(candidate.pattern);
    const hits = diff.added.filter((line) => regex.test(line.text));
    if (hits.length === 0) continue;
    if (diff.removed.some((line) => regex.test(line.text))) {
      rejected.push(`${candidate.pattern} (also in the removed lines)`);
      continue;
    }
    const glob = globForPaths(hits.map((hit) => hit.path));
    if (glob === null) {
      rejected.push(`${candidate.pattern} (offending files share no file kind)`);
      continue;
    }
    if (globSelectsWholeDirectory(glob)) {
      rejected.push(`${candidate.pattern} (only a directory-wide glob fits)`);
      continue;
    }
    return { pattern: candidate.pattern, glob, label: candidate.label };
  }
  const detail = rejected.length === 0 ? "no added line carries a distinctive literal or call" : rejected.join("; ");
  throw new CompileError(
    `cannot derive a check from this diff: ${detail}. Re-run with \`--model\` to ask a model for a candidate.`,
  );
}

/** The narrowest glob that covers every path: one file kind under their common directory. */
function globForPaths(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const extensions = new Set(paths.map((path) => extname(path)));
  if (extensions.size !== 1) return null;
  const extension = [...extensions][0];
  if (extension === undefined || extension === "") return null;

  const segments = paths.map((path) => {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    return dir === "" ? [] : dir.split("/");
  });
  let common = [...(segments[0] ?? [])];
  for (const entry of segments.slice(1)) {
    let index = 0;
    while (index < common.length && index < entry.length && common[index] === entry[index]) index += 1;
    common = common.slice(0, index);
  }
  const dir = common.join("/");
  return dir === "" ? `**/*${extension}` : `${dir}/**/*${extension}`;
}

export type CandidateSpec = {
  pattern: string;
  glob: string;
  label: string;
  /** `template` or the model name; recorded in provenance. */
  model: string;
  /** Used only when the snapshot carries no correction words. */
  claim?: string;
};

/**
 * Assemble the constraint both execution surfaces will run: the same regex as the span
 * trigger and as `content_check`, plus the negative `git grep` for `tree_check`.
 */
export async function composeCandidate(
  root: string,
  snapshot: SnapshotTarget,
  spec: CandidateSpec,
): Promise<Constraint> {
  const id = await nextConstraintId(root, slugFor(spec.label));
  const trigger: Trigger = { kind: "span", glob: spec.glob, pattern: spec.pattern };
  return withVersion({
    id,
    claim: snapshot.words !== "" ? snapshot.words : (spec.claim ?? `no ${spec.label}`),
    trigger,
    contentCheck: { pattern: spec.pattern },
    treeCheck: { cmd: treeCheckCommand(spec.pattern, spec.glob), timeoutSec: 30, expect: "no_match" },
    enforcement: "block",
    provenance: {
      badRef: snapshot.ref,
      goodRef: "worktree",
      words: snapshot.words,
      model: spec.model,
      base: snapshot.base,
      createdAt: new Date().toISOString(),
    },
    version: "",
  });
}

function treeCheckCommand(pattern: string, glob: string): string {
  return `git grep --untracked -nE ${shellQuote(pattern)} -- ${shellQuote(gitPathspec(glob))}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Filesystem-safe constraint suffix, e.g. `toISOString` → `no-raw-toisostring`. */
function slugFor(label: string): string {
  const body = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const prefix = /^\.?[A-Za-z_$][\w$]*$/.test(label) ? "no-raw-" : "no-";
  return `${prefix}${body === "" ? "check" : body}`;
}

/** Added and removed lines of the bad snapshot against its base tree. */
export async function snapshotDiff(root: string, snapshot: SnapshotTarget): Promise<DiffLines> {
  return diffLines(root, snapshot.base, snapshot.commit);
}

/** A label for an arbitrary candidate pattern, e.g. `\bany\b` → `any`. */
export function labelForPattern(pattern: string): string {
  const body = /^\/(.*)\/[a-z]*$/s.exec(pattern)?.[1] ?? pattern;
  const words = body.replace(/\\./g, " ").match(/[A-Za-z_$][\w$]*/g) ?? [];
  return [...words].sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? "check";
}

/** The correction as prompt-sized text: added and removed lines with their location. */
export function formatDiff(diff: DiffLines, limit = 80): string {
  const lines = [
    ...diff.added.map((line) => `+ ${line.path}:${line.line}: ${line.text}`),
    ...diff.removed.map((line) => `- ${line.path}:${line.line}: ${line.text}`),
  ];
  if (lines.length === 0) return "(empty)";
  const shown = lines.slice(0, limit);
  if (lines.length > limit) shown.push(`… ${lines.length - limit} more lines`);
  return shown.join("\n");
}
