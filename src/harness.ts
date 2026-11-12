import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Constraint } from "./constraint.js";
import { describeContentViolation, checkContent, type ProposedWrite } from "./enforce.js";
import { hooksDir } from "./gitdelta.js";

/**
 * The Claude Code side of enforcement. The harness runs `clamp hook pre-tool-use` before
 * a write and hands it a JSON event on stdin; a `tool_input.content` (Write) or
 * `tool_input.new_string` (Edit) that trips a `content_check` exits 2, which Claude Code
 * treats as "do not perform this tool call".
 */

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export type PreToolUseEvent = {
  toolName: string;
  filePath: string;
  /** The text the tool is about to write. */
  text: string;
  cwd: string;
  sessionId: string;
  toolUseId: string;
  transcriptPath: string;
};

export function parsePreToolUseEvent(raw: string): PreToolUseEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HarnessError("stdin is not a JSON payload");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new HarnessError("the hook payload is not a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const input = record["tool_input"];
  const fields = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  return {
    toolName: text(record["tool_name"]),
    filePath: text(fields["file_path"]),
    text: text(fields["content"]) || text(fields["new_string"]),
    cwd: text(record["cwd"]),
    sessionId: text(record["session_id"]),
    toolUseId: text(record["tool_use_id"]),
    transcriptPath: text(record["transcript_path"]),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type PreToolUseVerdict = { code: 0 | 2; message: string };

/**
 * Decide what the PreToolUse hook should do. `warn` constraints print but never block, so
 * only a `block` violation can return exit 2.
 */
export function evaluatePreToolUse(
  constraints: Constraint[],
  event: PreToolUseEvent,
): PreToolUseVerdict {
  if (event.text === "" || event.filePath === "") return { code: 0, message: "" };
  const write: ProposedWrite = { filePath: event.filePath, text: event.text };
  const violations = checkContent(constraints, write);
  if (violations.length === 0) return { code: 0, message: "" };

  // An Edit carries only a fragment, so a line number would point into the wrong file.
  const wholeFile = event.toolName === "Write";
  const blocked = violations.filter((violation) => violation.constraint.enforcement === "block");
  const warned = violations.filter((violation) => violation.constraint.enforcement === "warn");

  const lines: string[] = [];
  for (const violation of warned) lines.push(`clamp: ${describeContentViolation(violation, wholeFile)}`);
  for (const violation of blocked) lines.push(`clamp: ${describeContentViolation(violation, wholeFile)}`);
  if (blocked.length > 0) {
    lines.push(
      `clamp: blocked this write (exit 2) — ${blocked.length} constraint${blocked.length === 1 ? "" : "s"} refused it.`,
      "clamp: rewrite the offending line, or record a new correction with `clamp fix --words \"...\"` and `clamp compile <id>`.",
    );
    return { code: 2, message: `${lines.join("\n")}\n` };
  }
  return { code: 0, message: `${lines.join("\n")}\n` };
}

/** The JSON to paste into Claude Code's settings.json. */
export function settingsSnippet(command = "clamp hook pre-tool-use"): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

/**
 * Claude Code may send an absolute path; constraint globs are relative to the repository
 * root. git reports the worktree's real path, so a symlinked cwd (`/tmp` →
 * `/private/tmp`) needs a second look before judging the write to be outside the repo.
 */
export async function repoRelative(filePath: string, root: string): Promise<string> {
  if (!isAbsolute(filePath)) return filePath;
  const direct = relative(root, filePath);
  if (!direct.startsWith("..")) return direct;
  try {
    const realRoot = await realpath(root);
    const realDir = await realpath(dirname(filePath));
    return relative(realRoot, join(realDir, basename(filePath)));
  } catch {
    return direct;
  }
}

const HOOK_MARKER = "# clamp pre-commit v1";
const PREVIOUS_HOOK = "pre-commit.clamp-prev";

export type InstalledHook = { path: string; chained: boolean };

/**
 * Install the tree_check gate as the repository's `pre-commit` hook.
 *
 * The path comes from `git rev-parse --git-path hooks` so `core.hooksPath` and linked
 * worktrees work; a hook that was already installed is renamed and called first.
 * `CLAMP_BIN` overrides how the hook finds the CLI (a path to dist/cli.js, or `clamp`).
 */
export async function installPreCommitHook(
  root: string,
  recordedBin = "",
): Promise<InstalledHook> {
  const dir = await hooksDir(root);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "pre-commit");

  let chained = false;
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    await rename(path, join(dir, PREVIOUS_HOOK));
    chained = true;
  }
  await writeFile(path, preCommitScript(recordedBin), "utf8");
  await chmod(path, 0o755);
  return { path, chained };
}

/**
 * The hook records the CLI invocation that ran `init`, so enforcement still works from a
 * shell where `clamp` is not on PATH (the common npx/npm-script case). When nothing
 * resolves, the hook FAILS CLOSED — a guard that silently skips its checks is worse than
 * no guard at all.
 */
function preCommitScript(recordedBin: string): string {
  const recorded = shellQuote(recordedBin);
  return `#!/bin/sh
${HOOK_MARKER} — run tree_check over the worktree, untracked files included.
# A hook that was here before \`clamp init\` is preserved as ${PREVIOUS_HOOK} and runs first.
dir=$(dirname "$0")
if [ -x "$dir/${PREVIOUS_HOOK}" ]; then
  "$dir/${PREVIOUS_HOOK}" "$@" || exit $?
fi

root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1

if [ -n "\${CLAMP_BIN:-}" ]; then
  exec "$CLAMP_BIN" hook pre-commit
fi

recorded=${recorded}
if [ -n "$recorded" ]; then
  prog=$(printf '%s' "$recorded" | awk '{print $1}' | tr -d "'\\"")
  if command -v "$prog" >/dev/null 2>&1 || [ -x "$prog" ]; then
    eval "$recorded hook pre-commit"
    exit $?
  fi
fi

if [ -x node_modules/.bin/clamp ]; then
  exec node_modules/.bin/clamp hook pre-commit
fi
if command -v clamp >/dev/null 2>&1; then
  exec clamp hook pre-commit
fi

echo "clamp: no clamp CLI found (PATH, node_modules/.bin, or the path recorded at init)." >&2
echo "clamp: refusing to let the commit through unchecked — set CLAMP_BIN=<path to dist/cli.js> or re-run 'clamp init'." >&2
exit 1
`;
}

/** Single-quote a string for POSIX sh. */
function shellQuote(value: string): string {
  if (!value) return "";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
