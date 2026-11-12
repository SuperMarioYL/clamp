import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "./helpers.js";

/** Package root, one level above `.test-build/tests`. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function readDoc(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/** `clamp <command>` pairs from fenced code blocks, ignoring prose and comments. */
function documentedCommands(markdown: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const match = /^\s*(?:\$\s+)?clamp\s+(\S+)(?:\s+(\S+))?/.exec(line);
    if (match === null || match[1] === undefined) continue;
    const command = match[1];
    // The help block opens with `clamp — <tagline>`; only real command words count.
    if (!/^(?:-{1,2}[a-z-]+|[a-z][a-z-]*)$/.test(command)) continue;
    const sub = match[2];
    const invocation = command === "hook" && sub !== undefined && !sub.startsWith("-")
      ? `hook ${sub}`
      : command;
    if (!found.includes(invocation)) found.push(invocation);
  }
  return found;
}

function quickstartCommands(markdown: string, heading: RegExp): string[] {
  const start = markdown.split("\n").findIndex((line) => heading.test(line));
  assert.notEqual(start, -1, `missing quickstart heading ${heading}`);
  const rest = markdown.split("\n").slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return documentedCommands((end < 0 ? rest : rest.slice(0, end)).join("\n"));
}

test("every clamp command in the quickstart exists in the CLI help", () => {
  const help = runCli(ROOT, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["init", "fix", "compile", "replay"]) {
    assert.match(help.stdout, new RegExp(`^\\s*clamp ${command}\\b`, "m"), `help omits ${command}`);
  }

  for (const [doc, heading] of [
    ["README.md", /^## .*快速开始/],
    ["README.en.md", /^## .*Quickstart/],
  ] as const) {
    const commands = quickstartCommands(readDoc(doc), heading);
    for (const command of ["init", "fix", "compile", "replay"]) {
      assert.ok(commands.includes(command), `${doc} quickstart does not document ${command}`);
    }
    for (const command of documentedCommands(readDoc(doc))) {
      const pattern = new RegExp(
        `^\\s*clamp ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "m",
      );
      assert.match(help.stdout, pattern, `${doc} documents \`clamp ${command}\`, which help does not list`);
    }
  }
});

test("README links that point into the repository resolve", () => {
  for (const doc of ["README.md", "README.en.md"]) {
    const markdown = readDoc(doc);
    const targets = [
      ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
      ...[...markdown.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ];
    for (const target of targets) {
      if (target === undefined) continue;
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const path = target.split("#")[0] ?? "";
      assert.ok(existsSync(join(ROOT, path)), `${doc}: local link does not resolve: ${target}`);
    }
  }
});

test("the two READMEs are cross-linked and document the same commands", () => {
  const zh = readDoc("README.md");
  const en = readDoc("README.en.md");
  assert.match(zh.split("\n").slice(0, 6).join("\n"), /\[English\]\(README\.en\.md\)/);
  assert.match(en.split("\n").slice(0, 6).join("\n"), /\[简体中文\]\(README\.md\)/);

  const zhCommands = documentedCommands(zh).sort();
  const enCommands = documentedCommands(en).sort();
  assert.deepEqual(enCommands, zhCommands, "README.en.md drifted from README.md");
  assert.ok(en.length > zh.length * 0.6, "README.en.md looks like a stub, not a translation");
});

test("the demo cast is a valid recording of the real enforcement loop", () => {
  const cast = readFileSync(join(ROOT, "assets", "demo.cast"), "utf8");
  const [headerLine, ...eventLines] = cast.trimEnd().split("\n");
  assert.ok(headerLine !== undefined, "missing cast header");

  const header: unknown = JSON.parse(headerLine);
  assert.equal(typeof header, "object");
  assert.equal((header as Record<string, unknown>)["version"], 2);

  let previous = 0;
  let text = "";
  for (const line of eventLines) {
    const event: unknown = JSON.parse(line);
    assert.ok(Array.isArray(event) && event.length === 3, `malformed event: ${line}`);
    const [time, kind, data] = event as [unknown, unknown, unknown];
    assert.equal(kind, "o");
    assert.equal(typeof time, "number");
    assert.equal(typeof data, "string");
    assert.ok((time as number) >= previous, "cast timestamps must not go backwards");
    previous = time as number;
    text += data as string;
  }

  assert.ok(previous >= 35 && previous <= 50, `cast should run about 45s, ran ${previous}s`);
  for (const line of [
    "snapshot refs/clamp/bad/",
    "replay    fires_on_bad yes",
    "written   .clamp/constraints/0001-no-raw-toisostring.yaml",
    "clamp: blocked the commit (exit 2)",
    "content_check /\\.toISOString\\(\\)/ matched",
  ]) {
    assert.ok(text.includes(line), `cast is missing the real line: ${line}`);
  }
  assert.ok(!text.includes("/Users/"), "cast must not leak a local checkout path");
  assert.ok(existsSync(join(ROOT, "examples", "replay-repo", "src", "format.ts")));
});
