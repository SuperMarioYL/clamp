import { spawn } from "node:child_process";

export type ProcessResult = {
  /** Exit code, or null when the process could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
};

export type ProcessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to stdin before it is closed. */
  input?: string;
  timeoutMs?: number;
  /** Run the command through the platform shell (needed for user-authored check commands). */
  shell?: boolean;
};

/**
 * Spawn a child process and collect its output. A timeout kills the child and is
 * reported as `timedOut`, which callers must treat as a check error rather than a
 * pass (see expectVerdict).
 */
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      spawnError = error.message;
    });
    child.on("close", (code: number | null) => {
      finish({ code, stdout, stderr, timedOut, spawnError });
    });

    child.stdin.on("error", () => {
      // A command that exits without reading stdin is not an error for us.
    });
    child.stdin.end(options.input ?? "");
  });
}
