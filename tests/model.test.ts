import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  BAD_REPORT,
  GOOD_REPORT,
  GOOD_SCHEMA,
  cleanup,
  commitAll,
  fixWorktree,
  makeBadScenario,
  makeRepo,
  makeSemanticScenario,
  runCli,
  runCliAsync,
  startStubModel,
  writeFileAt,
} from "./helpers.js";

const MODEL_ENV = "CLAMP_MODEL_API_KEY";

function modelEnv(baseUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return { CLAMP_MODEL_BASE_URL: baseUrl, CLAMP_MODEL_API_KEY: "test-key", CLAMP_MODEL: "stub-model", ...extra };
}

test("compile --model stores a model candidate when the template has none", async () => {
  const scenario = await makeSemanticScenario();
  const stub = await startStubModel(
    JSON.stringify({ pattern: "\\bany\\b", glob: "src/**/*.ts", claim: "别用 any，统一走 zod" }),
  );
  try {
    await writeFileAt(scenario.root, "src/schema.ts", GOOD_SCHEMA);

    const run = await runCliAsync(scenario.root, ["compile", scenario.badId, "--model", "--yes"], {
      env: modelEnv(stub.baseUrl),
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /template {2}cannot derive a check from this diff/);
    assert.match(run.stdout, /candidate 0001-no-raw-any {2}span {2}src\/\*\*\/\*\.ts {2}\/\\bany\\b\//);
    assert.match(run.stdout, /replay {4}fires_on_bad yes · passes_on_good yes/);
    assert.match(run.stdout, /written {3}\.clamp\/constraints\/0001-no-raw-any\.yaml/);

    const yaml = await readFile(join(scenario.root, ".clamp/constraints/0001-no-raw-any.yaml"), "utf8");
    assert.match(yaml, /pattern: \\bany\\b/);
    assert.match(yaml, /model: stub-model/);
    assert.match(yaml, /claim: 别用 any，统一走 zod/);

    const request = stub.requests[0];
    assert.equal(request?.["model"], "stub-model");
    const messages = request?.["messages"];
    assert.ok(Array.isArray(messages));
    assert.match(JSON.stringify(messages), /别用 any/);
    assert.match(JSON.stringify(messages), /export type Payload = any;/);
  } finally {
    await stub.close();
    await cleanup(scenario.root);
  }
});

test("a model candidate that fails replay is refused, exactly like a template one", async () => {
  const scenario = await makeSemanticScenario();
  const stub = await startStubModel(JSON.stringify({ pattern: "\\bani\\b", glob: "src/**/*.ts" }));
  try {
    await writeFileAt(scenario.root, "src/schema.ts", GOOD_SCHEMA);

    const run = await runCliAsync(scenario.root, ["compile", scenario.badId, "--model", "--yes"], {
      env: modelEnv(stub.baseUrl),
    });
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /candidate 0001-no-raw-ani/);
    assert.match(run.stdout, /refused {3}fires_on_bad: /);
    assert.match(run.stdout, /nothing written/);
    assert.match(runCli(scenario.root, ["list"]).stdout, /no constraints/);
  } finally {
    await stub.close();
    await cleanup(scenario.root);
  }
});

test("an unreachable endpoint falls back to the template candidate with a clear message", async () => {
  const scenario = await reachableThenClosedScenario();
  try {
    const run = await runCliAsync(scenario.root, ["compile", scenario.badId, "--model", "--yes"], {
      env: modelEnv(scenario.deadBaseUrl),
    });
    // The template candidate is kept: its own replay result is still what decides.
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stdout, /candidate 0001-no-raw-toisostring/);
    assert.match(run.stdout, /model {5}unavailable: cannot reach http:\/\/127\.0\.0\.1:\d+\/v1/);
    assert.match(run.stdout, /model {5}keeping the template candidate/);
    assert.match(run.stdout, /refused {3}baseline: /);
    assert.match(runCli(scenario.root, ["list"]).stdout, /no constraints/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("--model without an API key reports the missing env var instead of calling out", async () => {
  const scenario = await makeSemanticScenario();
  try {
    await writeFileAt(scenario.root, "src/schema.ts", GOOD_SCHEMA);
    const env = { CLAMP_MODEL_BASE_URL: "http://127.0.0.1:1/v1" };
    const run = await runCliAsync(scenario.root, ["compile", scenario.badId, "--model", "--yes"], { env });

    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, new RegExp(`model {5}unavailable: ${MODEL_ENV} is not set`));
    assert.match(run.stdout, /no template candidate to keep/);
  } finally {
    await cleanup(scenario.root);
  }
});

test("the model is not consulted when the template already passes", async () => {
  const scenario = await makeBadScenario();
  const stub = await startStubModel(JSON.stringify({ pattern: "\\bnothing\\b", glob: "src/**/*.ts" }));
  try {
    await fixWorktree(scenario.root);
    const run = await runCliAsync(scenario.root, ["compile", scenario.badId, "--model", "--yes"], {
      env: modelEnv(stub.baseUrl),
    });
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /candidate 0001-no-raw-toisostring/);
    assert.doesNotMatch(run.stdout, /model {5}/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
    await cleanup(scenario.root);
  }
});

/** A history that already contains toISOString: the template fails baseline, so the model is asked. */
async function reachableThenClosedScenario(): Promise<{ root: string; badId: string; deadBaseUrl: string }> {
  const root = await makeRepo();
  await writeFileAt(root, "src/report.ts", GOOD_REPORT);
  await commitAll(root, "good report");
  await writeFileAt(root, "src/report.ts", BAD_REPORT);
  await commitAll(root, "report regressed");
  await writeFileAt(root, "src/report.ts", GOOD_REPORT);
  await commitAll(root, "report fixed");
  await writeFileAt(root, "src/digest.ts", BAD_REPORT);

  const fix = runCli(root, ["fix", "--words", "时间别自己拼"]);
  const badId = /snapshot refs\/clamp\/bad\/([0-9a-f]+)/.exec(fix.stdout)?.[1];
  assert.ok(badId);
  await fixWorktree(root);

  const stub = await startStubModel(JSON.stringify({ pattern: "\\bx\\b", glob: "src/**/*.ts" }));
  const deadBaseUrl = stub.baseUrl;
  await stub.close();
  return { root, badId, deadBaseUrl };
}
