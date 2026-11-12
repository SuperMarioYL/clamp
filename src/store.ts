import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConstraintError, formatConstraintYaml, parseConstraintYaml, withVersion, type Constraint } from "./constraint.js";

/** Everything under `.clamp/` and the snapshot ref namespace is this module's business. */
const CLAMP_DIR = ".clamp";
const SNAPSHOT_REF_PREFIX = "refs/clamp/bad/";
const SNAPSHOT_MESSAGE_PREFIX = "clamp snapshot";

export type StoreLayout = {
  dir: string;
  constraints: string;
};

export function storeLayout(root: string): StoreLayout {
  const dir = join(root, CLAMP_DIR);
  return { dir, constraints: join(dir, "constraints") };
}

export function snapshotRef(id: string): string {
  return `${SNAPSHOT_REF_PREFIX}${id}`;
}

export function snapshotIdFromRef(ref: string): string | null {
  return ref.startsWith(SNAPSHOT_REF_PREFIX) ? ref.slice(SNAPSHOT_REF_PREFIX.length) : null;
}

/**
 * The correction words live in the snapshot commit's message, so the only state a
 * snapshot owns is the ref itself: `clamp compile` reads the words back from git
 * instead of from a side file that could drift or leak into the user's commits.
 */
export function snapshotCommitMessage(words: string): string {
  return words === "" ? SNAPSHOT_MESSAGE_PREFIX : `${SNAPSHOT_MESSAGE_PREFIX}: ${words}`;
}

export function snapshotWordsFromMessage(message: string): string {
  const prefix = `${SNAPSHOT_MESSAGE_PREFIX}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length).split("\n")[0] ?? "" : "";
}

export async function initStore(root: string): Promise<StoreLayout> {
  const layout = storeLayout(root);
  await mkdir(layout.constraints, { recursive: true });
  return layout;
}

/** Write a constraint, always re-deriving its version from the content being written. */
export async function writeConstraint(
  root: string,
  candidate: Constraint,
): Promise<{ constraint: Constraint; path: string }> {
  const constraint = withVersion(candidate);
  const layout = storeLayout(root);
  await mkdir(layout.constraints, { recursive: true });
  const path = join(layout.constraints, `${constraint.id}.yaml`);
  await writeFile(path, formatConstraintYaml(constraint), "utf8");
  return { constraint, path };
}

export type StoredConstraint = { constraint: Constraint; path: string };

/**
 * Read a constraint by file path or by id. An id matches `<id>.yaml` first and then any
 * file starting with it, so `clamp replay 0001` works with `0001-no-raw-toisostring.yaml`.
 */
export async function readConstraint(root: string, idOrPath: string): Promise<StoredConstraint> {
  if (await isFile(idOrPath)) {
    return { constraint: parseConstraintYaml(await readFile(idOrPath, "utf8"), idOrPath), path: idOrPath };
  }
  const layout = storeLayout(root);
  const names = (await readdir(layout.constraints).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const name = names.find((entry) => entry === `${idOrPath}.yaml`) ?? names.find((entry) => entry.startsWith(idOrPath));
  if (name === undefined) {
    throw new ConstraintError(`no constraint "${idOrPath}" in ${layout.constraints}`);
  }
  const path = join(layout.constraints, name);
  return { constraint: parseConstraintYaml(await readFile(path, "utf8"), path), path };
}

export async function listConstraints(root: string): Promise<StoredConstraint[]> {
  const layout = storeLayout(root);
  const names = (await readdir(layout.constraints).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const stored: StoredConstraint[] = [];
  for (const name of names) {
    const path = join(layout.constraints, name);
    stored.push({ constraint: parseConstraintYaml(await readFile(path, "utf8"), path), path });
  }
  return stored;
}

/**
 * `<NNNN>-<slug>` for a new constraint: one past the highest number already stored, so
 * ids stay short, ordered and stable even after a constraint file is deleted by hand.
 */
export async function nextConstraintId(root: string, slug: string): Promise<string> {
  const layout = storeLayout(root);
  const names = (await readdir(layout.constraints).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".yaml"),
  );
  let highest = 0;
  for (const name of names) {
    const digits = /^(\d+)-/.exec(name)?.[1];
    if (digits !== undefined) highest = Math.max(highest, Number(digits));
  }
  return `${String(highest + 1).padStart(4, "0")}-${slug}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
