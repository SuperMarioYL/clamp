import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintError";
  }
}

/** `span` matches lines a change adds; `path` is "touching this kind of file is enough". */
export type SpanTrigger = { readonly kind: "span"; readonly glob: string; readonly pattern: string };
export type PathTrigger = { readonly kind: "path"; readonly glob: string };
export type Trigger = SpanTrigger | PathTrigger;

/**
 * What a command check promises. `match` passes when the command exits 0, `no_match`
 * passes when it exits 1 (a negative grep). Exit code 128 (invalid regex), any other
 * code, a timeout or a spawn failure is a check error, never a pass — see expectVerdict.
 */
export type CheckExpectation = "match" | "no_match";

export type ContentCheck = { readonly pattern: string };
export type TreeCheck = {
  readonly cmd: string;
  readonly timeoutSec: number;
  readonly expect: CheckExpectation;
};

export type Enforcement = "block" | "warn";

export type Provenance = {
  readonly badRef: string;
  readonly goodRef: string;
  readonly words: string;
  readonly model: string;
  /** Commit the bad snapshot was taken against, so a later reader can re-derive the diff. */
  readonly base: string;
  readonly createdAt: string;
};

export type Constraint = {
  readonly id: string;
  readonly claim: string;
  readonly trigger: Trigger;
  /** Regex over proposed text (PreToolUse: Write content or Edit new_string). */
  readonly contentCheck: ContentCheck | null;
  /** Command over a checked-out tree (pre-commit). */
  readonly treeCheck: TreeCheck | null;
  readonly enforcement: Enforcement;
  readonly provenance: Provenance;
  /** sha256 of the constraint content, first 12 hex chars. */
  readonly version: string;
};

export type CheckVerdict = "pass" | "fail" | "error";

/**
 * Does a trigger glob cover `path`? `**` crosses directory separators, `*` and `?` do
 * not, which is the same meaning git gives the pathspec in `tree_check` (`:(glob)`).
 */
export function globMatchesPath(glob: string, path: string): boolean {
  const normalized = glob.startsWith(":(") ? glob.replace(/^:\([a-z-]+\)/, "") : glob;
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += (char ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`).test(path);
}

/**
 * A glob whose last segment is `*`/`**` only names a directory, not a kind of file, so
 * it fires on everything below it (`src/**` is "all of src"). Such a trigger cannot say
 * which changes deserve the check, so the gate refuses it.
 */
export function globSelectsWholeDirectory(glob: string): boolean {
  const normalized = (glob.startsWith(":(") ? glob.replace(/^:\([a-z-]+\)/, "") : glob).replace(/^\.\//, "");
  if (normalized === "" || normalized === ".") return true;
  const last = normalized.slice(normalized.lastIndexOf("/") + 1);
  return last === "" || last === "*" || last === "**";
}

/**
 * The single place that turns an exit code into a verdict. 0 and 1 carry meaning for
 * both expectations; 128 (invalid regex), 127 (missing command), signals and timeouts
 * mean the check itself broke down and must fail closed.
 */
export function expectVerdict(expect: CheckExpectation, exitCode: number | null): CheckVerdict {
  if (exitCode === null) return "error";
  if (exitCode !== 0 && exitCode !== 1) return "error";
  if (expect === "match") return exitCode === 0 ? "pass" : "fail";
  return exitCode === 1 ? "pass" : "fail";
}

/**
 * Compile a stored pattern. A `/…/flags` literal is accepted as well as a bare source,
 * and the stateful `g`/`y` flags are dropped because every call site only asks
 * "does anything here match".
 */
export function compilePattern(source: string): RegExp {
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(source);
  const body = literal ? (literal[1] ?? "") : source;
  const flags = (literal ? (literal[2] ?? "") : "").replace(/[gy]/g, "");
  try {
    return new RegExp(body, flags);
  } catch (error) {
    throw new ConstraintError(`invalid regex "${source}": ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function constraintVersion(constraint: Constraint): string {
  return createHash("sha256").update(JSON.stringify(canonicalForm(constraint))).digest("hex").slice(0, 12);
}

export function withVersion(constraint: Constraint): Constraint {
  return { ...constraint, version: constraintVersion(constraint) };
}

/** Snake_case document shape; also the input to the version hash, in a fixed key order. */
function canonicalForm(constraint: Constraint): Record<string, unknown> {
  const trigger =
    constraint.trigger.kind === "span"
      ? { kind: "span", glob: constraint.trigger.glob, pattern: constraint.trigger.pattern }
      : { kind: "path", glob: constraint.trigger.glob };
  return {
    id: constraint.id,
    claim: constraint.claim,
    enforcement: constraint.enforcement,
    trigger,
    content_check: constraint.contentCheck === null ? null : { pattern: constraint.contentCheck.pattern },
    tree_check:
      constraint.treeCheck === null
        ? null
        : {
            cmd: constraint.treeCheck.cmd,
            timeout_sec: constraint.treeCheck.timeoutSec,
            expect: constraint.treeCheck.expect,
          },
    provenance: {
      bad_ref: constraint.provenance.badRef,
      good_ref: constraint.provenance.goodRef,
      words: constraint.provenance.words,
      model: constraint.provenance.model,
      base: constraint.provenance.base,
      created_at: constraint.provenance.createdAt,
    },
  };
}

export function formatConstraintYaml(constraint: Constraint): string {
  return stringifyYaml({ ...canonicalForm(constraint), version: constraint.version });
}

export function parseConstraintYaml(text: string, source = "constraint"): Constraint {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConstraintError(`${source}: invalid YAML: ${errorMessage(error)}`);
  }
  return parseConstraint(raw, source);
}

export function parseConstraint(raw: unknown, source = "constraint"): Constraint {
  const doc = asRecord(raw, source);
  const id = nonEmptyString(doc["id"], `${source}.id`);
  const claim = optionalString(doc, "claim", source);
  const enforcement = parseEnforcement(doc["enforcement"], `${source}.enforcement`);

  const trigger = parseTrigger(doc["trigger"], `${source}.trigger`);
  const contentCheck = parseContentCheck(doc["content_check"], `${source}.content_check`);
  const treeCheck = parseTreeCheck(doc["tree_check"], `${source}.tree_check`);
  if (contentCheck === null && treeCheck === null) {
    throw new ConstraintError(`${source}: needs content_check or tree_check (or both)`);
  }

  const provenance = parseProvenance(doc["provenance"], `${source}.provenance`);
  const versionRaw = doc["version"];
  const parsed: Constraint = {
    id,
    claim,
    trigger,
    contentCheck,
    treeCheck,
    enforcement,
    provenance,
    version: typeof versionRaw === "string" && versionRaw !== "" ? versionRaw : "",
  };
  return parsed.version === "" ? withVersion(parsed) : parsed;
}

function parseEnforcement(value: unknown, where: string): Enforcement {
  if (value === undefined || value === null) return "block";
  if (value === "block" || value === "warn") return value;
  throw new ConstraintError(`${where}: expected "block" or "warn"`);
}

function parseTrigger(value: unknown, where: string): Trigger {
  const record = asRecord(value, where);
  const kind = nonEmptyString(record["kind"], `${where}.kind`);
  const glob = nonEmptyString(record["glob"], `${where}.glob`);
  if (kind === "path") return { kind, glob };
  if (kind === "span") {
    const pattern = nonEmptyString(record["pattern"], `${where}.pattern`);
    compilePattern(pattern);
    return { kind, glob, pattern };
  }
  throw new ConstraintError(`${where}.kind: expected "span" or "path", got "${kind}"`);
}

function parseContentCheck(value: unknown, where: string): ContentCheck | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, where);
  const pattern = nonEmptyString(record["pattern"], `${where}.pattern`);
  compilePattern(pattern);
  return { pattern };
}

function parseTreeCheck(value: unknown, where: string): TreeCheck | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, where);
  const cmd = nonEmptyString(record["cmd"], `${where}.cmd`);
  const timeoutRaw = record["timeout_sec"];
  let timeoutSec = 30;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
      throw new ConstraintError(`${where}.timeout_sec: expected a positive number of seconds`);
    }
    timeoutSec = timeoutRaw;
  }
  return { cmd, timeoutSec, expect: parseExpect(record["expect"], `${where}.expect`) };
}

function parseExpect(value: unknown, where: string): CheckExpectation {
  const raw = nonEmptyString(value, where);
  // The plan names the exit-0 expectation "exit0"; both spellings carry the same meaning.
  if (raw === "match" || raw === "exit0") return "match";
  if (raw === "no_match") return "no_match";
  throw new ConstraintError(`${where}: expected "match", "no_match" or "exit0", got "${raw}"`);
}

function parseProvenance(value: unknown, where: string): Provenance {
  const record = value === undefined || value === null ? {} : asRecord(value, where);
  return {
    badRef: nonEmptyString(record["bad_ref"], `${where}.bad_ref`),
    goodRef: optionalString(record, "good_ref", where),
    words: optionalString(record, "words", where),
    model: optionalString(record, "model", where),
    base: optionalString(record, "base", where),
    createdAt: optionalString(record, "created_at", where),
  };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConstraintError(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new ConstraintError(`${where}: expected a string`);
  if (value.trim() === "") throw new ConstraintError(`${where}: must not be empty`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ConstraintError(`${where}.${key}: expected a string`);
  return value;
}
