import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotWordsFromMessage } from "../src/store.js";
import {
  BAD_DIGEST,
  cleanup,
  commitAll,
  git,
  makeRepo,
  runCli,
  writeFileAt,
} from "./helpers.js";

test("init creates the constraint store", async () => {
  const root = await makeRepo();
  try {
    const run = runCli(root, ["init"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /wrote \.clamp\//);
    assert.equal(git(root, ["status", "--porcelain", "--untracked-files=all"]), "");
    const listing = runCli(root, ["list"]);
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /no constraints/);
  } finally {
    await cleanup(root);
  }
});

test("init outside a git repository fails with a clear message", async () => {
  const plain = await mkdtemp(join(tmpdir(), "clamp-nogit-"));
  try {
    const run = runCli(plain, ["init"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a git repository/);
  } finally {
    await cleanup(plain);
  }
});

test("fix refuses a clean worktree and writes no ref", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/report.ts", "export const report = 1;\n");
    await commitAll(root, "base");

    const run = runCli(root, ["fix", "--words", "这里不对"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /nothing to snapshot/);
    assert.equal(git(root, ["for-each-ref", "refs/clamp/bad", "--format=%(refname)"]), "");
  } finally {
    await cleanup(root);
  }
});

test("fix snapshots a new untracked file and keeps the words in the commit message", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/report.ts", "export const report = 1;\n");
    await commitAll(root, "base");
    await writeFileAt(root, "src/digest.ts", BAD_DIGEST);

    const words = "时间别自己拼，统一用 formatDate";
    const run = runCli(root, ["fix", "--words", words]);
    assert.equal(run.status, 0, run.stderr);
    const ref = /snapshot (refs\/clamp\/bad\/[0-9a-f]+)/.exec(run.stdout)?.[1];
    assert.ok(ref, run.stdout);
    assert.match(run.stdout, /3 added lines/);
    assert.match(run.stdout, /src\/digest\.ts:2/);

    const message = git(root, ["log", "-1", "--format=%B", ref]);
    assert.equal(snapshotWordsFromMessage(message), words);
  } finally {
    await cleanup(root);
  }
});

test("replay and check fail cleanly for an unknown constraint", async () => {
  const root = await makeRepo();
  try {
    await writeFileAt(root, "src/report.ts", "export const report = 1;\n");
    await commitAll(root, "base");

    const replay = runCli(root, ["replay", "0099-nope"]);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /no constraint/);

    const check = runCli(root, ["check"]);
    assert.equal(check.status, 0);
    assert.match(check.stdout, /no constraints/);
  } finally {
    await cleanup(root);
  }
});

test("an unknown command prints usage and exits 1", async () => {
  const root = await makeRepo();
  try {
    const run = runCli(root, ["compil"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown command/);
    assert.match(run.stderr, /clamp init/);
  } finally {
    await cleanup(root);
  }
});
