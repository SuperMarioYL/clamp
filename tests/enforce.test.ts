import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkContent } from "../src/enforce.js";
import { parseConstraintYaml } from "../src/constraint.js";
import {
  BAD_REPORT,
  CLI,
  GOOD_DIGEST,
  GOOD_REPORT,
  cleanup,
  fixWorktree,
  git,
  gitMaybe,
  makeBadScenario,
  preToolUseEvent,
  runCli,
  writeFileAt,
} from "./helpers.js";

const CONSTRAINT = "0001-no-raw-toisostring";

async function scenarioWithConstraint(): Promise<{ root: string; badId: string }> {
  const scenario = await makeBadScenario();
  await fixWorktree(scenario.root);
  const compile = runCli(scenario.root, ["compile", scenario.badId, "--yes"]);
  if (compile.status !== 0) throw new Error(`compile failed: ${compile.stdout}${compile.stderr}`);
  return { root: scenario.root, badId: scenario.badId };
}

test("pre-tool-use blocks a Write that carries the offending call", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const bad = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({
        cwd: root,
        filePath: "src/digest.ts",
        content: 'export function render(d: Date) {\n  return d.toISOString();\n}\n',
      }),
    });
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stderr, /0001-no-raw-toisostring {2}src\/digest\.ts:2 {2}content_check/);
    assert.match(bad.stderr, /\\\.toISOString\\\(\\\)/);
    assert.match(bad.stderr, /blocked this write \(exit 2\)/);

    const good = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({ cwd: root, filePath: "src/digest.ts", content: GOOD_REPORT }),
    });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stderr, "");
  } finally {
    await cleanup(root);
  }
});

test("pre-tool-use matches an absolute file_path against the repository-relative glob", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const bad = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({
        cwd: root,
        filePath: join(root, "src/digest.ts"),
        content: 'export const when = new Date().toISOString();\n',
      }),
    });
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stderr, /src\/digest\.ts:1/);
  } finally {
    await cleanup(root);
  }
});

test("pre-tool-use checks an Edit's new_string, not its old_string", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const editsIntoBad = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({
        cwd: root,
        filePath: "src/report.ts",
        toolName: "Edit",
        oldString: 'return "Report " + formatDate(d);',
        newString: 'return "Report " + d.toISOString();',
      }),
    });
    assert.equal(editsIntoBad.status, 2, editsIntoBad.stdout);
    // An Edit carries a fragment, so no line number is claimed for the file.
    assert.match(editsIntoBad.stderr, /0001-no-raw-toisostring {2}src\/report\.ts {2}content_check/);
    assert.doesNotMatch(editsIntoBad.stderr, /src\/report\.ts:\d+/);

    const editsAway = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({
        cwd: root,
        filePath: "src/report.ts",
        toolName: "Edit",
        oldString: 'return "Report " + d.toISOString();',
        newString: 'return "Report " + formatDate(d);',
      }),
    });
    assert.equal(editsAway.status, 0, editsAway.stderr);
  } finally {
    await cleanup(root);
  }
});

test("pre-tool-use ignores files outside the trigger glob and payloads it cannot read", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const other = runCli(root, ["hook", "pre-tool-use"], {
      input: preToolUseEvent({
        cwd: root,
        filePath: "docs/notes.md",
        content: "use toISOString() in prose\n",
      }),
    });
    assert.equal(other.status, 0, other.stderr);

    const empty = runCli(root, ["hook", "pre-tool-use"], { input: "" });
    assert.equal(empty.status, 0);
    assert.match(empty.stderr, /expects the PreToolUse JSON on stdin/);

    const broken = runCli(root, ["hook", "pre-tool-use"], { input: "not json" });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /stdin is not a JSON payload/);
  } finally {
    await cleanup(root);
  }
});

test("checkContent applies only the constraints whose trigger covers the file", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const stored = parseConstraintYaml(
      await readFile(join(root, ".clamp/constraints", `${CONSTRAINT}.yaml`), "utf8"),
    );
    const hits = checkContent([stored], {
      filePath: "src/digest.ts",
      text: "x\ny\nd.toISOString()\n",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.line, 3);
    assert.equal(hits[0]?.sample, "d.toISOString()");
    assert.deepEqual(
      checkContent([stored], { filePath: "lib/digest.ts", text: "d.toISOString()\n" }),
      [],
    );
  } finally {
    await cleanup(root);
  }
});

test("init --hooks installs the pre-commit gate where git looks for hooks", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const run = runCli(root, ["init", "--hooks"]);
    assert.equal(run.status, 0, run.stderr);
    const hookPath = join(resolveHooksDir(root), "pre-commit");
    const info = await stat(hookPath);
    assert.ok(info.isFile());
    assert.ok((info.mode & 0o111) !== 0, "the hook must be executable");
    assert.match(await readFile(hookPath, "utf8"), /clamp pre-commit v1/);
    assert.match(run.stdout, /"PreToolUse"/);
    assert.match(run.stdout, /clamp hook pre-tool-use/);
  } finally {
    await cleanup(root);
  }
});

test("the pre-commit hook blocks a commit that reintroduces the call", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    assert.equal(runCli(root, ["init", "--hooks"]).status, 0);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add the constraint"]);

    await writeFileAt(root, "src/digest.ts", 'export const when = new Date().toISOString();\n');
    git(root, ["add", "-A"]);
    const blocked = gitMaybe(root, ["commit", "-q", "-m", "feat: digest"], { CLAMP_BIN: CLI });
    assert.notEqual(blocked.status, 0, blocked.stdout);
    assert.match(blocked.stderr, /0001-no-raw-toisostring {2}blocked {2}src\/digest\.ts:1/);
    assert.match(blocked.stderr, /check failed: git grep --untracked/);
    assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "2");

    await writeFileAt(root, "src/digest.ts", GOOD_DIGEST);
    await writeFileAt(root, "src/extra.ts", "export const extra = 1;\n");
    git(root, ["add", "-A"]);
    const allowed = gitMaybe(root, ["commit", "-q", "-m", "feat: digest"], { CLAMP_BIN: CLI });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "3");
  } finally {
    await cleanup(root);
  }
});

test("the pre-commit hook sees an untracked file that git commit -am would never stage", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    assert.equal(runCli(root, ["init", "--hooks"]).status, 0);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add the constraint"]);

    // src/brand-new.ts is untracked; `git commit -am` stages nothing from it.
    await writeFileAt(root, "src/brand-new.ts", 'export const raw = new Date().toISOString();\n');
    const blocked = gitMaybe(root, ["commit", "-am", "feat: brand new"], { CLAMP_BIN: CLI });
    assert.notEqual(blocked.status, 0, blocked.stdout);
    assert.match(blocked.stderr, /src\/brand-new\.ts:1/);
  } finally {
    await cleanup(root);
  }
});

test("init --hooks keeps an existing pre-commit hook by chaining it", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    const hooks = resolveHooksDir(root);
    const marker = join(root, "previous-hook-ran");
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\n# a hook that was here first\necho ran > "${marker}"\nexit 0\n`,
      { mode: 0o755 },
    );

    const run = runCli(root, ["init", "--hooks"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /previous hook kept as pre-commit\.clamp-prev/);

    // Idempotent: a second init rewrites the same hook and chains nothing twice.
    const again = runCli(root, ["init", "--hooks"]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /previous hook kept/);

    const bad = join(root, "src/digest.ts");
    await writeFile(bad, 'export const when = new Date().toISOString();\n');
    git(root, ["add", "-A"]);
    const blocked = gitMaybe(root, ["commit", "-q", "-m", "regression"], { CLAMP_BIN: CLI });
    assert.notEqual(blocked.status, 0, blocked.stdout);
    assert.equal(await readFile(marker, "utf8"), "ran\n", "the previous hook still runs");
  } finally {
    await cleanup(root);
  }
});

test("a linked worktree installs the hook where git actually runs it", async () => {
  const { root } = await scenarioWithConstraint();
  const worktree = `${root}-wt`;
  try {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add the constraint"]);
    git(root, ["worktree", "add", "-q", "-b", "linked", worktree]);
    try {
      const run = runCli(worktree, ["init", "--hooks"]);
      assert.equal(run.status, 0, run.stderr);

      const hookPath = join(resolveHooksDir(worktree), "pre-commit");
      assert.ok((await stat(hookPath)).isFile(), `expected a hook at ${hookPath}`);
      const inside = join(worktree, ".git");
      assert.ok((await stat(inside)).isFile(), "a linked worktree has .git as a file");

      await writeFileAt(worktree, "src/digest.ts", 'export const when = new Date().toISOString();\n');
      git(worktree, ["add", "-A"]);
      const blocked = gitMaybe(worktree, ["commit", "-q", "-m", "regression"], { CLAMP_BIN: CLI });
      assert.notEqual(blocked.status, 0, blocked.stdout);
      assert.match(blocked.stderr, /0001-no-raw-toisostring/);
    } finally {
      gitMaybe(root, ["worktree", "remove", "--force", worktree]);
    }
  } finally {
    await cleanup(root);
    await cleanup(worktree);
  }
});

test("clamp check warns without blocking for a warn constraint", async () => {
  const scenario = await makeBadScenario();
  try {
    await fixWorktree(scenario.root);
    const compiled = runCli(scenario.root, ["compile", scenario.badId, "--yes"]);
    assert.equal(compiled.status, 0, compiled.stdout);
    await writeFileAt(scenario.root, "src/report.ts", BAD_REPORT);

    assert.equal(runCli(scenario.root, ["check"]).status, 2);
    const yamlPath = join(scenario.root, ".clamp/constraints", `${CONSTRAINT}.yaml`);
    const yaml = await readFile(yamlPath, "utf8");
    await writeFile(yamlPath, yaml.replace("enforcement: block", "enforcement: warn"));

    const warned = runCli(scenario.root, ["check"]);
    assert.equal(warned.status, 0, warned.stdout);
    assert.match(warned.stdout, /0001-no-raw-toisostring {2}warn {2}src\/report\.ts:/);
  } finally {
    await cleanup(scenario.root);
  }
});

function resolveHooksDir(root: string): string {
  const raw = git(root, ["rev-parse", "--git-path", "hooks"]);
  return raw.startsWith("/") ? raw : join(root, raw);
}

test("the installed hook enforces without CLAMP_BIN on PATH (recorded at init)", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    assert.equal(runCli(root, ["init", "--hooks"]).status, 0);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add the constraint"]);

    await writeFileAt(root, "src/digest.ts", 'export const when = new Date().toISOString();\n');
    git(root, ["add", "-A"]);
    // No CLAMP_BIN in the environment — the hook must fall back to the invocation recorded
    // at init time instead of silently skipping its checks.
    const blocked = gitMaybe(root, ["commit", "-q", "-m", "feat: digest"]);
    assert.notEqual(blocked.status, 0, "the hook must block, not skip");
    assert.match(blocked.stderr, /0001-no-raw-toisostring {2}blocked {2}src\/digest\.ts:1/);
    assert.doesNotMatch(blocked.stderr, /skipping tree checks/);
  } finally {
    await cleanup(root);
  }
});

test("the hook fails closed when no clamp CLI can be found", async () => {
  const { root } = await scenarioWithConstraint();
  try {
    assert.equal(runCli(root, ["init", "--hooks"]).status, 0);
    git(root, ["add", "-A"]);
    const hookPath = join(resolveHooksDir(root), "pre-commit");
    // Break every resolution path: drop the recorded invocation and hide node_modules bins.
    const script = await readFile(hookPath, "utf8");
    await writeFile(hookPath, script.replace(/^recorded=.*$/m, "recorded="), "utf8");
    await rm(join(root, "node_modules"), { recursive: true, force: true }).catch(() => {});
    const blocked = gitMaybe(root, ["commit", "-q", "-m", "init"], { PATH: "/usr/bin:/bin" });
    assert.notEqual(blocked.status, 0, "a guard that cannot run must refuse, not pass");
    assert.match(blocked.stderr, /refusing to let the commit through unchecked/);
  } finally {
    await cleanup(root);
  }
});
