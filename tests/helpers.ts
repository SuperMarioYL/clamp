import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/cli.js` of the package under test. Tests run after `npm run build`. */
export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export type CliRun = { status: number | null; stdout: string; stderr: string };

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  delete env["CLAMP_MODEL_BASE_URL"];
  delete env["CLAMP_BASE_URL"];
  delete env["CLAMP_MODEL_API_KEY"];
  delete env["CLAMP_MODEL"];
  delete env["CLAMP_BIN"];
  return env;
}

export type RunOptions = { input?: string; env?: Record<string, string> };

export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), ...(env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** git that is allowed to fail; used to prove a hook blocked a commit. */
export function gitMaybe(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), ...(env ?? {}) },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clamp-test-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Clamp Test"]);
  git(root, ["config", "user.email", "clamp@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

export async function writeFileAt(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

export async function commitAll(root: string, message: string): Promise<string> {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

export function runCli(cwd: string, args: string[], options: RunOptions = {}): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: options.input ?? "",
    env: { ...cleanEnv(), ...(options.env ?? {}) },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The same run, without blocking the event loop. Tests that serve the model endpoint from
 * this process must use it: `spawnSync` would freeze the server that has to answer.
 */
export function runCliAsync(cwd: string, args: string[], options: RunOptions = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...cleanEnv(), ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export const GOOD_FORMAT = `export function formatDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}
`;

export const GOOD_REPORT = `import { formatDate } from "./format.js";

export function renderReport(d: Date): string {
  return "Report " + formatDate(d);
}
`;

export const GOOD_DIGEST = `import { formatDate } from "./format.js";

export function renderDigest(d: Date): string {
  return "Digest " + formatDate(d);
}
`;

export const BAD_REPORT = `export function renderReport(d: Date): string {
  return "Report " + d.toISOString();
}
`;

export const BAD_DIGEST = `export function renderDigest(d: Date): string {
  return "Digest " + d.toISOString();
}
`;

/**
 * A repository with one clean commit, a bad worktree (a modified tracked file plus a
 * brand-new untracked file, both calling toISOString), and a recorded bad snapshot.
 */
export type BadScenario = { root: string; badRef: string; badId: string };

export async function makeBadScenario(words = "时间别自己拼，统一用 formatDate"): Promise<BadScenario> {
  const root = await makeRepo();
  await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
  await writeFileAt(root, "src/report.ts", GOOD_REPORT);
  await commitAll(root, "add report rendering");

  await writeFileAt(root, "src/report.ts", BAD_REPORT);
  await writeFileAt(root, "src/digest.ts", BAD_DIGEST);

  const fix = runCli(root, ["fix", "--words", words]);
  if (fix.status !== 0) throw new Error(`clamp fix failed: ${fix.stderr}`);
  const match = /snapshot (refs\/clamp\/bad\/[0-9a-f]+)/.exec(fix.stdout);
  if (match?.[1] === undefined) throw new Error(`unexpected fix output: ${fix.stdout}`);
  const badRef = match[1];
  return { root, badRef, badId: badRef.slice("refs/clamp/bad/".length) };
}

/** Turn the worktree of a bad scenario into the fixed version. */
export async function fixWorktree(root: string): Promise<void> {
  await writeFileAt(root, "src/report.ts", GOOD_REPORT);
  await writeFileAt(root, "src/digest.ts", GOOD_DIGEST);
}

export const BASE_SCHEMA = "export type Payload = unknown;\n";

export const BAD_SCHEMA = "export type Payload = any;\n";

export const GOOD_SCHEMA = `import { z } from "zod";

export const Payload = z.object({ id: z.string() });
`;

/**
 * A semantically corrected change: "don't use any, go through zod". Nothing in the diff
 * carries a call or a literal, so the deterministic template has no candidate and only a
 * model suggestion can pass the gates.
 */
export async function makeSemanticScenario(words = "别用 any，统一走 zod"): Promise<BadScenario> {
  const root = await makeRepo();
  await writeFileAt(root, "src/schema.ts", BASE_SCHEMA);
  await commitAll(root, "add payload type");
  await writeFileAt(root, "src/schema.ts", BAD_SCHEMA);

  const fix = runCli(root, ["fix", "--words", words]);
  if (fix.status !== 0) throw new Error(`clamp fix failed: ${fix.stderr}`);
  const match = /snapshot (refs\/clamp\/bad\/[0-9a-f]+)/.exec(fix.stdout);
  if (match?.[1] === undefined) throw new Error(`unexpected fix output: ${fix.stdout}`);
  const badRef = match[1];
  return { root, badRef, badId: badRef.slice("refs/clamp/bad/".length) };
}

export type StubModel = {
  baseUrl: string;
  /** Request bodies the CLI sent, in order. */
  requests: Array<Record<string, unknown>>;
  /** Change what the next request answers with. */
  answer: (content: string) => void;
  close: () => Promise<void>;
};

/** A local OpenAI-compatible endpoint; no test ever reaches the network. */
export async function startStubModel(initial: string): Promise<StubModel> {
  const requests: Array<Record<string, unknown>> = [];
  let content = initial;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({ raw: body });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    answer: (next: string) => {
      content = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A PreToolUse payload as Claude Code sends it. */
export function preToolUseEvent(options: {
  cwd: string;
  filePath: string;
  toolName?: string;
  content?: string;
  newString?: string;
  oldString?: string;
}): string {
  const toolInput: Record<string, unknown> = { file_path: options.filePath };
  if (options.content !== undefined) toolInput["content"] = options.content;
  if (options.newString !== undefined) toolInput["new_string"] = options.newString;
  if (options.oldString !== undefined) toolInput["old_string"] = options.oldString;
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: options.toolName ?? "Write",
    session_id: "test-session",
    cwd: options.cwd,
    tool_use_id: "toolu_test",
    transcript_path: join(options.cwd, "transcript.jsonl"),
    tool_input: toolInput,
  });
}

export type ConstraintOptions = { pattern?: string; badRef: string; expect?: string; cmd?: string };

export async function writeHandWrittenConstraint(
  root: string,
  id: string,
  options: ConstraintOptions,
): Promise<string> {
  const pattern = options.pattern ?? "\\.toISOString\\(\\)";
  const cmd =
    options.cmd ?? "git grep --untracked -nE '\\.toISOString\\(\\)' -- ':(glob)src/**/*.ts'";
  const text = `id: ${id}
claim: 时间别自己拼，统一用 formatDate
enforcement: block
trigger:
  kind: span
  glob: src/**/*.ts
  pattern: ${pattern}
content_check:
  pattern: ${pattern}
tree_check:
  cmd: ${cmd}
  timeout_sec: 15
  expect: ${options.expect ?? "no_match"}
provenance:
  bad_ref: ${options.badRef}
  good_ref: worktree
  words: 时间别自己拼，统一用 formatDate
  model: template
`;
  await writeFileAt(root, `.clamp/constraints/${id}.yaml`, text);
  return join(root, ".clamp", "constraints", `${id}.yaml`);
}
