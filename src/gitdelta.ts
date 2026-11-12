import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runProcess } from "./proc.js";

/** Error codes callers are expected to branch on. */
export type GitErrorCode = "not_a_repo" | "empty_snapshot" | "ref_conflict" | "command_failed";

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

type GitOptions = { env?: NodeJS.ProcessEnv; input?: string };

type GitResult = { code: number | null; stdout: string; stderr: string };

async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const result = await runProcess("git", args, {
    cwd,
    env: options.env,
    input: options.input,
    timeoutMs: 120_000,
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function gitOrThrow(
  cwd: string,
  args: string[],
  context: string,
  options: GitOptions = {},
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new GitError("command_failed", `${context} failed: git ${args.join(" ")}: ${detail}`);
  }
  return result.stdout;
}

/** Commit message body, used to read the correction words back out of a snapshot. */
export async function commitMessage(root: string, revision: string): Promise<string> {
  return (await gitOrThrow(root, ["log", "-1", "--format=%B", revision], "read commit message")).trim();
}

/**
 * Directory git runs hooks from: `core.hooksPath` when set, otherwise the repository's
 * `.git/hooks` (the common dir, so a linked worktree shares it). In a linked worktree
 * `.git` is a file, so `<repo>/.git/hooks` cannot be assumed.
 */
export async function hooksDir(root: string): Promise<string> {
  const raw = (await gitOrThrow(root, ["rev-parse", "--git-path", "hooks"], "resolve hooks dir")).trim();
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

/** Absolute path of the worktree root that contains `dir`. */
export async function repoRoot(dir: string): Promise<string> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    throw new GitError("not_a_repo", `not a git repository: ${dir}`);
  }
  return result.stdout.trim();
}

/** Commit that HEAD points at, or null in an unborn repository. */
export async function headCommit(root: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Resolve any revision expression to a commit, or null when it does not resolve. */
export async function resolveCommit(root: string, revision: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--verify", "-q", `${revision}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** First parent of a commit, or null for a root commit. */
export async function parentCommit(root: string, revision: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--verify", "-q", `${revision}^`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function commitTree(root: string, revision: string): Promise<string> {
  return (await gitOrThrow(root, ["rev-parse", `${revision}^{tree}`], "read commit tree")).trim();
}

/** Tree of the current index. Fails on unmerged entries, which is the honest outcome. */
export async function writeIndexTree(root: string): Promise<string> {
  return (await gitOrThrow(root, ["write-tree"], "write index tree")).trim();
}

/** The empty tree object, used as diff base for root commits and empty repositories. */
export async function emptyTree(root: string): Promise<string> {
  return (await gitOrThrow(root, ["hash-object", "-t", "tree", "--stdin"], "hash empty tree", { input: "" })).trim();
}

/** Create a commit object without touching HEAD, the index or the worktree. */
export async function createCommit(
  root: string,
  tree: string,
  message: string,
  parent?: string | null,
): Promise<string> {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", message);
  return (await gitOrThrow(root, args, "create snapshot commit")).trim();
}

/**
 * Tree of the current worktree, including files that are not tracked yet.
 *
 * `git stash create` cannot be used here: it only records modified tracked files and
 * returns an empty sha when the only change is a brand-new file. A throwaway index
 * plus `git add -A` stages the whole worktree (honouring .gitignore) without touching
 * the user's index or creating a commit.
 */
export async function worktreeTree(
  root: string,
): Promise<{ tree: string; base: string | null; emptyTree: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "clamp-index-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await gitOrThrow(root, ["add", "-A", "--", "."], "stage worktree", { env });
    const tree = (await gitOrThrow(root, ["write-tree"], "write worktree tree", { env })).trim();
    return { tree, base: await headCommit(root), emptyTree: await emptyTree(root) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export type Snapshot = {
  /** Short, content-derived handle; also the last segment of `ref`. */
  id: string;
  ref: string;
  commit: string;
  tree: string;
  /** Commit the snapshot was taken against, or null in an unborn repository. */
  base: string | null;
};

export type SnapshotOptions = {
  /** Maps a snapshot id to the ref that should point at it. */
  refFor: (id: string) => string;
  message?: string;
};

/**
 * Record the whole worktree (untracked files included) as a commit and point `ref` at it.
 *
 * Throws GitError("empty_snapshot") instead of writing a ref when the worktree carries
 * no change relative to HEAD, or when it is entirely empty. An empty ref would make
 * every later replay meaningless, so it must never be created.
 */
export async function snapshotWorktree(root: string, options: SnapshotOptions): Promise<Snapshot> {
  const { tree, base, emptyTree: empty } = await worktreeTree(root);
  if (tree === empty) {
    throw new GitError("empty_snapshot", "nothing to snapshot: the worktree has no files");
  }
  if (base !== null && (await commitTree(root, base)) === tree) {
    throw new GitError("empty_snapshot", `nothing to snapshot: the worktree matches ${base.slice(0, 12)}`);
  }

  const { id, ref } = await pickSnapshotId(root, tree, options.refFor);
  const commit = await createCommit(root, tree, options.message ?? "clamp snapshot", base);
  const update = await git(root, ["update-ref", ref, commit]);
  if (update.code !== 0) {
    throw new GitError("command_failed", `cannot write ${ref}: ${update.stderr.trim()}`);
  }
  return { id, ref, commit, tree, base };
}

/**
 * Shortest prefix (4 hex chars and up) that does not collide with an existing snapshot
 * ref. A ref that already points at the same tree is reused, which makes `clamp fix`
 * idempotent for an unchanged worktree.
 */
async function pickSnapshotId(
  root: string,
  tree: string,
  refFor: (id: string) => string,
): Promise<{ id: string; ref: string }> {
  for (let length = 4; length <= tree.length; length += 2) {
    const id = tree.slice(0, length);
    const ref = refFor(id);
    const existing = await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (existing.code !== 0) return { id, ref };
    const existingTree = await git(root, ["rev-parse", `${ref}^{tree}`]);
    if (existingTree.code === 0 && existingTree.stdout.trim() === tree) return { id, ref };
  }
  throw new GitError("ref_conflict", `cannot derive a unique snapshot id from tree ${tree}`);
}

/**
 * Pathspec for a trigger glob. A bare `src/**\/*.ts` is interpreted as two `*` around a
 * literal `/`, so it needs at least one subdirectory and misses `src/report.ts`;
 * `:(glob)` makes `**` mean "any depth". Commands quoted in a constraint must pass the
 * same form to git.
 */
export function gitPathspec(glob: string): string {
  return glob.startsWith(":(") ? glob : `:(glob)${glob}`;
}

export type AddedLine = { path: string; line: number; text: string };

/** Both sides of a tree diff. The removed side is what a correction took away. */
export type DiffLines = { added: AddedLine[]; removed: AddedLine[] };

/**
 * Lines added and removed by the change from `from` to `to` (both any tree-ish),
 * optionally limited to a glob. The glob is handed to git as `:(glob)…` because a bare
 * `src/**\/*.ts` pathspec would require an extra directory level and miss `src/report.ts`.
 */
export async function diffLines(
  root: string,
  from: string,
  to: string,
  glob?: string,
): Promise<DiffLines> {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    from,
    to,
  ];
  if (glob) args.push("--", gitPathspec(glob));
  const patch = await gitOrThrow(root, args, "diff trees");
  return parseDiffLines(patch);
}

/** Lines added by the change from `from` to `to`, optionally limited to a glob. */
export async function addedLines(
  root: string,
  from: string,
  to: string,
  glob?: string,
): Promise<AddedLine[]> {
  return (await diffLines(root, from, to, glob)).added;
}

function parseDiffLines(patch: string): DiffLines {
  const added: AddedLine[] = [];
  const removed: AddedLine[] = [];
  let path: string | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = headerPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = header?.[1] === undefined ? 0 : Number(header[1]);
      newLine = header?.[2] === undefined ? 0 : Number(header[2]);
      continue;
    }
    if (raw.startsWith("+")) {
      if (path !== null) added.push({ path, line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      if (path !== null) removed.push({ path, line: oldLine, text: raw.slice(1) });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { added, removed };
}

function headerPath(raw: string): string | null {
  let value = raw;
  const tab = value.indexOf("\t");
  if (tab >= 0) value = value.slice(0, tab);
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value.startsWith("b/") ? value.slice(2) : value;
}

export type ChangedFile = { path: string; status: string };

/** Files touched by the change from `from` to `to`, optionally limited to a glob. */
export async function changedFiles(
  root: string,
  from: string,
  to: string,
  glob?: string,
): Promise<ChangedFile[]> {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-status",
    "--no-renames",
    "--no-color",
    "-z",
    from,
    to,
  ];
  if (glob) args.push("--", gitPathspec(glob));
  const output = await gitOrThrow(root, args, "diff --name-status");
  const tokens = output.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (status !== undefined && status !== "" && path !== undefined) {
      files.push({ status, path });
    }
  }
  return files;
}

export type HistoryCommit = { rev: string; parents: string[] };

/** The last `limit` commits reachable from HEAD, newest first. Empty without a HEAD. */
export async function recentCommits(root: string, limit: number): Promise<HistoryCommit[]> {
  if (limit <= 0 || (await headCommit(root)) === null) return [];
  const output = await gitOrThrow(
    root,
    ["rev-list", `--max-count=${limit}`, "--parents", "HEAD"],
    "list history",
  );
  const commits: HistoryCommit[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const rev = parts[0];
    if (rev !== undefined) commits.push({ rev, parents: parts.slice(1) });
  }
  return commits;
}

/**
 * Run `fn` in a throwaway detached worktree checked out at `revision`, then remove it.
 * Commands that must see real files (git grep, a test runner) need this; a bare object
 * read cannot run arbitrary shell commands against a historical tree.
 */
export async function withCommitWorktree<T>(
  root: string,
  revision: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "clamp-worktree-"));
  const dir = join(scratch, "tree");
  let added = false;
  try {
    const result = await git(root, ["worktree", "add", "--detach", "-q", dir, revision]);
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `cannot check out ${revision.slice(0, 12)}: ${result.stderr.trim()}`,
      );
    }
    added = true;
    return await fn(dir);
  } finally {
    if (added) {
      const removed = await git(root, ["worktree", "remove", "--force", dir]);
      if (removed.code !== 0) await git(root, ["worktree", "prune"]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
