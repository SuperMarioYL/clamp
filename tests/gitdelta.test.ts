import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  GitError,
  addedLines,
  emptyTree,
  gitPathspec,
  headCommit,
  snapshotWorktree,
  worktreeTree,
} from "../src/gitdelta.js";
import { snapshotRef } from "../src/store.js";
import { BAD_DIGEST, BAD_REPORT, GOOD_FORMAT, cleanup, commitAll, git, makeRepo, writeFileAt } from "./helpers.js";

const refFor = snapshotRef;

test("snapshot records a modified tracked file and a brand-new untracked file", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await writeFileAt(root, "src/report.ts", "export const report = 1;\n");
    const head = await commitAll(root, "base");

    await writeFileAt(root, "src/report.ts", BAD_REPORT);
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);

    const snapshot = await snapshotWorktree(root, { refFor, message: "clamp snapshot" });

    assert.equal(snapshot.base, head);
    assert.equal(git(root, ["rev-parse", `${snapshot.ref}^{commit}`]), snapshot.commit);
    const files = git(root, ["ls-tree", "-r", "--name-only", snapshot.commit]).split("\n");
    assert.ok(files.includes("src/digest.ts"), "untracked file must be part of the snapshot");
    assert.ok(files.includes("src/report.ts"));
  } finally {
    await cleanup(root);
  }
});

test("a new untracked file on its own is enough to produce a snapshot", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    const head = await commitAll(root, "base");

    // The only change is a new file; `git stash create` would return an empty sha here.
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const snapshot = await snapshotWorktree(root, { refFor, message: "clamp snapshot" });

    assert.notEqual(snapshot.tree, git(root, ["rev-parse", `${head}^{tree}`]));
    const files = git(root, ["ls-tree", "-r", "--name-only", snapshot.ref]).split("\n");
    assert.deepEqual(files.sort(), ["src/digest.ts", "src/format.ts"]);
  } finally {
    await cleanup(root);
  }
});

test("an unchanged worktree is an error and writes no ref", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await commitAll(root, "base");

    await assert.rejects(
      () => snapshotWorktree(root, { refFor, message: "clamp snapshot" }),
      (error: unknown) => error instanceof GitError && error.code === "empty_snapshot",
    );
    assert.equal(git(root, ["for-each-ref", "refs/clamp/bad", "--format=%(refname)"]), "");
  } finally {
    await cleanup(root);
  }
});

test("an empty repository is an error and writes no ref", async () => {
  const root = await makeRepo();
  try {
    await assert.rejects(
      () => snapshotWorktree(root, { refFor, message: "clamp snapshot" }),
      (error: unknown) => error instanceof GitError && error.code === "empty_snapshot",
    );
    assert.equal(git(root, ["for-each-ref", "refs/clamp/bad", "--format=%(refname)"]), "");
  } finally {
    await cleanup(root);
  }
});

test("addedLines reports the new file with real line numbers", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    const base = await commitAll(root, "base");
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const snapshot = await snapshotWorktree(root, { refFor, message: "clamp snapshot" });

    const lines = await addedLines(root, base, snapshot.commit);
    const offending = lines.filter((line) => line.text.includes("toISOString"));
    assert.equal(offending.length, 1);
    assert.equal(offending[0]?.path, "src/digest.ts");
    assert.equal(offending[0]?.line, 2);
  } finally {
    await cleanup(root);
  }
});

test("taking the same snapshot twice reuses the ref instead of overwriting it", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await commitAll(root, "base");
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);

    const first = await snapshotWorktree(root, { refFor, message: "clamp snapshot" });
    const second = await snapshotWorktree(root, { refFor, message: "clamp snapshot" });
    assert.equal(second.id, first.id);
    assert.equal(second.tree, first.tree);
    assert.equal(git(root, ["for-each-ref", "refs/clamp/bad", "--format=%(refname)"]), first.ref);
  } finally {
    await cleanup(root);
  }
});

test("trigger globs become pathspecs that see files directly under the root", async () => {
  assert.equal(gitPathspec("src/**/*.ts"), ":(glob)src/**/*.ts");
  assert.equal(gitPathspec(":(glob)src/**"), ":(glob)src/**");

  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);
    const bare = spawnSync("git", ["grep", "--untracked", "-nE", "toISOString", "--", "src/**/*.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    // A bare `**` needs one extra directory level, so src/digest.ts is invisible.
    assert.equal(bare.status, 1);

    const globbed = spawnSync(
      "git",
      ["grep", "--untracked", "-nE", "toISOString", "--", gitPathspec("src/**/*.ts")],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(globbed.status, 0);
    assert.match(globbed.stdout, /src\/digest\.ts:2:/);
  } finally {
    await cleanup(root);
  }
});

test("worktreeTree keeps the user index untouched", async () => {  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/format.ts", GOOD_FORMAT);
    await commitAll(root, "base");
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);

    const before = await emptyTree(root);
    assert.match(before, /^[0-9a-f]{40}$/);
    await worktreeTree(root);
    assert.equal(git(root, ["status", "--porcelain"]), "?? src/digest.ts");
    assert.equal(await headCommit(root), git(root, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(root);
  }
});
