import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConstraintError,
  compilePattern,
  expectVerdict,
  formatConstraintYaml,
  parseConstraintYaml,
  type Constraint,
} from "../src/constraint.js";

const SAMPLE = `id: 0001-no-raw-toisostring
claim: 时间别自己拼，统一用 formatDate
enforcement: block
trigger:
  kind: span
  glob: src/**/*.ts
  pattern: \\.toISOString\\(\\)
content_check:
  pattern: /\\.toISOString\\(\\)/
tree_check:
  cmd: git grep --untracked -nE '\\.toISOString\\(\\)' -- ':(glob)src/**/*.ts'
  timeout_sec: 15
  expect: no_match
provenance:
  bad_ref: refs/clamp/bad/7f3a
  good_ref: worktree
  words: 时间别自己拼，统一用 formatDate
  model: template
`;

const NO_CHECKS = `id: 0002-no-checks
trigger:
  kind: path
  glob: src/**/*.ts
provenance:
  bad_ref: refs/clamp/bad/7f3a
`;

function sample(): Constraint {
  return parseConstraintYaml(SAMPLE, "sample.yaml");
}

test("expectVerdict models 0/1 explicitly and fails closed on anything else", () => {
  assert.equal(expectVerdict("match", 0), "pass");
  assert.equal(expectVerdict("match", 1), "fail");
  assert.equal(expectVerdict("match", 128), "error");
  assert.equal(expectVerdict("no_match", 1), "pass");
  assert.equal(expectVerdict("no_match", 0), "fail");
  assert.equal(expectVerdict("no_match", 128), "error");
  assert.equal(expectVerdict("no_match", 2), "error");
  assert.equal(expectVerdict("match", 127), "error");
  assert.equal(expectVerdict("match", null), "error");
});

test("a hand-written constraint parses into the typed model", () => {
  const constraint = sample();
  assert.equal(constraint.id, "0001-no-raw-toisostring");
  assert.equal(constraint.trigger.kind, "span");
  assert.equal(constraint.trigger.glob, "src/**/*.ts");
  assert.equal(constraint.contentCheck?.pattern, "/\\.toISOString\\(\\)/");
  assert.equal(constraint.treeCheck?.expect, "no_match");
  assert.equal(constraint.treeCheck?.timeoutSec, 15);
  assert.equal(constraint.provenance.badRef, "refs/clamp/bad/7f3a");
  assert.equal(constraint.enforcement, "block");
  assert.match(constraint.version, /^[0-9a-f]{12}$/);
});

test("the version is derived from content and survives a format/parse round trip", () => {
  const constraint = sample();
  const reparsed = parseConstraintYaml(formatConstraintYaml(constraint), "formatted.yaml");
  assert.equal(reparsed.version, constraint.version);
  assert.deepEqual(reparsed.provenance, constraint.provenance);
});

test("key order in the file does not change the version", () => {
  const reordered = `claim: 时间别自己拼，统一用 formatDate
provenance:
  model: template
  words: 时间别自己拼，统一用 formatDate
  good_ref: worktree
  bad_ref: refs/clamp/bad/7f3a
tree_check:
  expect: no_match
  timeout_sec: 15
  cmd: git grep --untracked -nE '\\.toISOString\\(\\)' -- ':(glob)src/**/*.ts'
content_check:
  pattern: /\\.toISOString\\(\\)/
trigger:
  pattern: \\.toISOString\\(\\)
  glob: src/**/*.ts
  kind: span
enforcement: block
id: 0001-no-raw-toisostring
`;
  assert.equal(parseConstraintYaml(reordered, "reordered.yaml").version, sample().version);
});

test("the plan's exit0 spelling is accepted as an alias for match", () => {
  const constraint = parseConstraintYaml(SAMPLE.replace("expect: no_match", "expect: exit0"), "alias.yaml");
  assert.equal(constraint.treeCheck?.expect, "match");
});

test("a constraint without any check is rejected", () => {
  assert.throws(() => parseConstraintYaml(NO_CHECKS, "empty.yaml"), ConstraintError);
});

test("an invalid trigger regex is rejected at parse time", () => {
  assert.throws(
    () => parseConstraintYaml(SAMPLE.replace("pattern: \\.toISOString\\(\\)", "pattern: (["), "bad.yaml"),
    ConstraintError,
  );
});

test("an unknown trigger kind is rejected", () => {
  assert.throws(() => parseConstraintYaml(SAMPLE.replace("kind: span", "kind: ast"), "bad.yaml"), ConstraintError);
});

test("a /…/ literal compiles and drops stateful flags", () => {
  const pattern = compilePattern("/foo/gi");
  assert.equal(pattern.source, "foo");
  assert.equal(pattern.flags, "i");
  assert.ok(pattern.test("FOO"));
  assert.ok(pattern.test("FOO"), "repeated tests must not depend on lastIndex");
});
