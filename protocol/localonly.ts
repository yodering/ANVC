/**
 * Local only: nothing ANVC keeps leaves this computer.
 *
 * Records are git refs, so any git host can carry them, and none has to. A
 * repository with no remote, or whose owner doesn't want records on one,
 * needs a guarantee rather than a combination of settings to get right. With
 * local only on:
 *
 * - every record is written private, whatever the agent or a preset asks for,
 *   so turning it off later shares nothing that was made meanwhile;
 * - ANVC's push and fetch settings are taken off every remote, and anvc init
 *   refuses to put them back;
 * - anvc share and anvc sync refuse, and the pre-push check stops any push
 *   that names an ANVC ref.
 *
 * Kept in its own file beside the policy, so choosing a preset or pasting a
 * policy line can never turn it off by accident.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitOrNull, remoteNames, unconfigureRemote } from "./git";
import { readDefaults } from "./policy";

export const LOCAL_ONLY_REFUSAL =
  "This repository is local only: ANVC keeps everything on this computer. To change that, turn off Local only in Settings, or run: anvc local off";

/**
 * A file in this clone's .git/anvc, which every worktree of it shares: where
 * a project's own settings are kept. Null outside a repository.
 */
export function marker(repo: string, name = "local-only"): string | null {
  const dir = gitOrNull(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return dir ? join(dir, "anvc", name) : null;
}

/**
 * On when this project turned it on, or when it was chosen for every project
 * (~/.anvc/defaults.json) and this project didn't turn it off.
 */
export function isLocalOnly(repo: string): boolean {
  const path = marker(repo);
  if (path === null) return false;
  if (existsSync(path)) return true;
  const off = marker(repo, "local-off");
  return Boolean(readDefaults().localOnly) && !(off && existsSync(off));
}

/**
 * Turns local only on or off. On takes ANVC's settings off every remote and
 * says how many; off changes nothing on any remote, since sharing again is a
 * separate decision (anvc init).
 */
export function setLocalOnly(repo: string, on: boolean): { unset: number } {
  const path = marker(repo);
  if (!path) throw new Error("not a git repository");
  const off = marker(repo, "local-off")!;
  if (!on) {
    rmSync(path, { force: true });
    // Chosen for every project: this one says otherwise, and keeps saying it.
    if (readDefaults().localOnly) { mkdirSync(dirname(off), { recursive: true }); writeFileSync(off, "Local only is off here, whatever the default.\n"); }
    return { unset: 0 };
  }
  rmSync(off, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `Local only since ${new Date().toISOString()}. Nothing ANVC keeps is pushed or fetched.\n`);
  let unset = 0;
  for (const remote of remoteNames(repo)) unset += unconfigureRemote(repo, remote);
  return { unset };
}
