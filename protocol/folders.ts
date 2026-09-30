/**
 * Which folders ANVC works in.
 *
 * Installed once for an agent, ANVC runs in every git repository that agent
 * opens: nobody sets up each project, the way nobody sets up git per clone.
 * Each folder has one switch, on unless someone turned it off, and every hook
 * and the MCP server check it first. Off means nothing is captured, nothing is
 * shown to the agent and nothing is saved there.
 *
 * The list also names every folder ANVC has run in, so the work log can show
 * them all with their switches in one place.
 */
import { join } from "node:path";
import { readJson, samePath, writeJson } from "./rawlog";
import { stateHome } from "./version";

interface Folder { repo: string; on: boolean; seen: string }

/** `seen` is missing for a folder switched from the Folders page before ANVC ran there. */
type Store = Record<string, { on: boolean; seen?: string; told?: boolean }>;

const file = () => join(stateHome(), "folders.json");
const read = (): Store => readJson<Store>(file(), {});
const write = (store: Store): void => writeJson(file(), store);

/** Whether ANVC works in this repository. On unless turned off. */
export function folderOn(given: string): boolean {
  const repo = samePath(given);
  return read()[repo]?.on !== false;
}

/**
 * Turns ANVC on or off in a repository, and lists it among the folders ANVC
 * has run in. The Folders page's switch for a repository it found passes
 * `listed` false, since ANVC hasn't run there.
 */
export function setFolder(given: string, on: boolean, listed = true): void {
  const repo = samePath(given);
  const store = read();
  const seen = store[repo]?.seen ?? (listed ? new Date().toISOString() : undefined);
  store[repo] = { ...store[repo], on, ...(seen ? { seen } : {}) };
  write(store);
}

/**
 * Notes that ANVC ran here. Returns true the first time, so the person can be
 * told once that it is on and how to turn it off.
 */
export function noteFolder(given: string): boolean {
  const repo = samePath(given);
  const store = read();
  const first = !store[repo]?.seen;
  const today = new Date().toISOString().slice(0, 10);
  // One write a day at most: this runs at every session start.
  if (!first && store[repo]!.seen!.slice(0, 10) === today) return false;
  store[repo] = { ...store[repo], on: store[repo]?.on ?? true, seen: new Date().toISOString() };
  try { write(store); } catch { return false; }
  return first;
}

/**
 * True once per folder: the first time the person can be told that ANVC is
 * on here and how to turn it off.
 */
export function tellOnce(given: string): boolean {
  const repo = samePath(given);
  const store = read();
  if (store[repo]?.told) return false;
  store[repo] = { on: store[repo]?.on ?? true, seen: store[repo]?.seen ?? new Date().toISOString(), told: true };
  try { write(store); } catch { return false; }
  return true;
}

/** Every folder ANVC has run in, most recently used first. */
export function folders(): Folder[] {
  return Object.entries(read())
    .flatMap(([repo, f]) => (f.seen ? [{ repo, on: f.on !== false, seen: f.seen }] : []))
    .sort((a, b) => b.seen.localeCompare(a.seen));
}
