/**
 * Takes ANVC out of a project for a while, and puts it back: `anvc remove`
 * and `anvc restore`.
 *
 * Before a project goes public, the records on its remote are development
 * history anyone could then read. git can delete them; nothing gets them back
 * unless a copy was kept. So remove writes one file first, a git bundle of
 * every ANVC ref in the clone with the project's settings inside it, checks
 * it with git bundle verify, and deletes nothing unless both worked.
 *
 * Records on a remote that this clone never fetched are fetched before the
 * backup is written, so deleting them there can't lose them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { repoRoot } from "./activity";
import { flag, has } from "./args";
import { folderOn, setFolder } from "./folders";
import { configureRemote, git, gitOrNull, readRefs, remoteNames } from "./git";
import { isLocalOnly } from "./localonly";
import { installPrePush, prePushOn } from "./prepush";
import { below, isRepo } from "./rawlog";
import { privateRemote } from "./sync";
import { uninstall, type Uninstalled } from "./uninstall";
import { installs, SETUP, stateHome } from "./version";

type Ref = { ref: string; oid: string };

/** Every ref ANVC writes, and the copies fetched from a remote: refs/anvc/, refs/anvc-private/ and the rest. */
const ANVC_REF = /^refs\/(remotes\/[^/]+\/)?anvc(-[a-z]+)?\//;
const RECORD_REF = /^refs\/(remotes\/[^/]+\/)?anvc(-private)?\//;
/** The same refs as a remote holds them. */
const REMOTE_REF = /^refs\/anvc(-[a-z]+)?\//;
/** Where the backup's own settings travel inside the bundle, named for the project. Never left in a clone. */
const SETTINGS_REF = "refs/anvc-backup/";

const backupDir = (): string => join(stateHome(), "backups");

/**
 * "214 records", or "214 records and 12 other ANVC refs" for the raw log and
 * session copies. A record and the copy a fetch or push left of it under
 * refs/remotes/ are one record.
 */
function counted(refs: Ref[]): string {
  const kept = refs.filter((r) => RECORD_REF.test(r.ref));
  const records = new Set(kept.map((r) => r.oid)).size;
  const other = refs.length - kept.length;
  const n = (k: number, one: string) => `${k.toLocaleString()} ${one}${k === 1 ? "" : "s"}`;
  return `${n(records, "record")}${other ? ` and ${n(other, "other ANVC ref")}` : ""}`;
}

/** The project a path is in: its folder, the root every worktree shares, and what identifies it on any machine. */
function project(given: string) {
  const top = gitOrNull(given, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`${given} isn't in a git repository with a working folder`);
  const root = repoRoot(top) ?? top;
  // The first commit is the same in every clone; a folder's path isn't.
  const first = gitOrNull(top, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n").filter(Boolean).sort()[0];
  const id = first ?? createHash("sha1").update(root).digest("hex");
  const settings = join(git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "anvc");
  return { top, root, id, settings };
}

/** An error's message, or whatever was thrown. */
const said = (error: unknown): string => error instanceof Error ? error.message : String(error);

const anvcRefs = (repo: string): Ref[] => readRefs(repo, "refs/").filter((r) => ANVC_REF.test(r.ref) && !r.ref.startsWith(SETTINGS_REF));

/** git over the network. A remote that doesn't answer mustn't hang the page, so this gives up after two minutes. */
function remoteGit(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  if (r.status !== 0) {
    const said = (r.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
    throw new Error(said ?? `git ${args[0]} failed${r.error ? `: ${r.error.message}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

/** Refs as ls-remote and bundle list-heads print them: an oid, a tab or a space, and the ref. */
const refLines = (out: string): Ref[] => out.split("\n").filter(Boolean).map((line) => {
  const [oid = "", ref = ""] = line.split(/[\t ]/);
  return { ref, oid };
});

/** The ANVC refs a remote holds now. */
function remoteRefs(repo: string, remote: string): Ref[] {
  if (!remoteNames(repo).includes(remote)) throw new Error(`there's no remote named ${remote}`);
  return refLines(remoteGit(repo, ["ls-remote", "--refs", remote])).filter((r) => REMOTE_REF.test(r.ref));
}

/** What setup changed here, so restore --setup can change it back. */
interface Setup { agents: string[]; remotes: string[]; prePush: boolean; privateRemote: string | null }

interface Meta {
  anvc_backup: 1;
  project: string;
  repo: string;
  created: string;
  settings: Record<string, string>;
  setup: Setup;
  /** Remotes the records were deleted from, so restore can say how to push them back. */
  removedFrom: string[];
}

function readSettings(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile());
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

function setupHere(p: ReturnType<typeof project>): Setup {
  // Setup notes the folder as it was given, which may reach it through a symlink.
  const matchers = [isRepo(p.root), isRepo(p.top)];
  const here = (path: unknown) => matchers.some((m) => m(path));
  const travels = (r: string) => ["push", "fetch"].some((k) => (gitOrNull(p.top, ["config", "--get-all", `remote.${r}.${k}`]) ?? "").includes("refs/anvc/"));
  return {
    agents: [...new Set(installs().filter((i) => here(i.repo)).map((i) => i.agent))],
    remotes: remoteNames(p.top).filter(travels),
    prePush: prePushOn(p.top),
    privateRemote: privateRemote(p.top),
  };
}

/**
 * Writes the backup and checks it: git bundle verify, then every ref read
 * back from the file with the object it should point at. Throws, and leaves
 * no file, when either fails.
 */
export function backup(given: string, removedFrom: string[] = []): { file: string; refs: Ref[] } {
  const p = project(given);
  const refs = anvcRefs(p.top);
  const meta: Meta = {
    anvc_backup: 1, project: p.id, repo: p.root, created: new Date().toISOString(),
    settings: readSettings(p.settings), setup: setupHere(p), removedFrom,
  };
  const dir = backupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // The sv-SE locale writes local time as 2026-09-30 14:05:09, which becomes 2026-09-30-140509.
  const stamp = new Date(meta.created).toLocaleString("sv-SE").replace(" ", "-").replaceAll(":", "");
  const name = basename(p.root).replace(/[^A-Za-z0-9._-]/g, "-");
  let file = join(dir, `${name}-${stamp}.bundle`);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${name}-${stamp}-${i}.bundle`);

  const settingsRef = `${SETTINGS_REF}${p.id}`;
  git(p.top, ["update-ref", settingsRef, git(p.top, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(meta) })]);
  try {
    git(p.top, ["bundle", "create", "--quiet", file, "--stdin"], { input: [settingsRef, ...refs.map((r) => r.ref)].join("\n") + "\n" });
    chmodSync(file, 0o600);
    git(p.top, ["bundle", "verify", "--quiet", file]);
    const heads = new Map(bundleHeads(p.top, file).map((h) => [h.ref, h.oid]));
    const missing = refs.filter((r) => heads.get(r.ref) !== r.oid);
    if (missing.length || !heads.has(settingsRef)) throw new Error(`the backup doesn't hold ${missing[0]?.ref ?? "the settings"}`);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  } finally {
    gitOrNull(p.top, ["update-ref", "-d", settingsRef]);
  }
  return { file, refs };
}

const bundleHeads = (repo: string, file: string): Ref[] => refLines(git(repo, ["bundle", "list-heads", file]));

/** What remove will do, for the page to ask about before anything happens. Reaches each remote. */
export function removalPlan(given: string) {
  const p = project(given);
  const here = anvcRefs(p.top);
  const remotes = remoteNames(p.top).map((remote) => {
    const url = gitOrNull(p.top, ["remote", "get-url", "--push", remote]) ?? "";
    try {
      const refs = remoteRefs(p.top, remote);
      return { remote, url, refs: refs.length, says: counted(refs) };
    } catch (error) {
      return { remote, url, refs: null, says: `couldn't reach it: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }).filter((r) => r.refs !== 0);
  return { dir: backupDir(), here: here.length, says: counted(here), remotes, setup: setupChanges(p) };
}

/**
 * What the uninstall that follows will change, read from the project without
 * changing it. Its own list, printed after, is the exact one.
 */
function setupChanges(p: ReturnType<typeof project>): string[] {
  const s = setupHere(p);
  const hooked = [".claude/settings.local.json", ".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json", ".cursor/mcp.json"].filter((rel) => {
    try { return /emitters\/claude-code\/|"anvc(@anvc)?"\s*:/.test(readFileSync(join(p.top, rel), "utf8")); } catch { return false; }
  });
  return [
    ...(folderOn(p.root) ? ["Turn ANVC off in this folder"] : []),
    ...s.remotes.map((r) => `Stop records going with git push and fetch on ${r}`),
    ...hooked.map((rel) => `Take ANVC's entries out of ${rel}`),
    ...(s.prePush ? ["Take out the pre-push check"] : []),
    ...(existsSync(p.settings) ? ["Delete this project's ANVC settings"] : []),
  ];
}

interface Removed {
  file: string;
  here: string;
  remotes: Array<{ remote: string; deleted: string; left: number | null; error?: string }>;
  uninstalled: Uninstalled | null;
}

/**
 * Backs up, then deletes every ANVC ref in this clone, then on each remote
 * named, then takes out what setup added unless `keepSetup`. Nothing is
 * deleted anywhere until the backup is written and checked.
 */
export function remove(given: string, opts: { remotes?: string[]; keepSetup?: boolean; instructions?: boolean } = {}): Removed {
  const p = project(given);
  let targets: Array<{ remote: string; refs: Ref[] }>, file: string, refs: Ref[];
  try {
    targets = (opts.remotes ?? []).map((remote) => {
      const theirs = remoteRefs(p.top, remote);
      // Into the same place a fetch of the team's records goes, so the backup
      // holds every one, including those this clone never fetched.
      if (theirs.length) remoteGit(p.top, ["fetch", "--quiet", "--no-tags", remote, `+refs/anvc*:refs/remotes/${remote}/anvc*`]);
      return { remote, refs: theirs };
    });
    ({ file, refs } = backup(p.top, targets.map((t) => t.remote)));
    const kept = new Map(refs.map((r) => [r.ref, r.oid]));
    for (const { remote, refs: theirs } of targets) {
      const lost = theirs.find((r) => kept.get(r.ref.replace(/^refs\//, `refs/remotes/${remote}/`)) !== r.oid);
      if (lost) throw new Error(`${lost.ref} on ${remote} isn't in the backup at ${file}`);
    }
    // One transaction, and each ref only if it still points where the backup has it.
    if (refs.length) git(p.top, ["update-ref", "--stdin"], { input: refs.map((r) => `delete ${r.ref} ${r.oid}\n`).join("") });
  } catch (error) {
    throw new Error(`${said(error)}. Nothing was deleted.`);
  }

  const remotes = targets.map(({ remote, refs: theirs }) => {
    let deleted: Ref[] = [];
    let error: string | undefined;
    // A lease on each ref: one that changed since the backup stays. Batched,
    // since a command line holds only so many refs. --no-verify, because a
    // deletion shares nothing, and the pre-push check stops any push naming
    // an ANVC ref when local only is on.
    for (let i = 0; i < theirs.length && !error; i += 200) {
      const chunk = theirs.slice(i, i + 200);
      try {
        remoteGit(p.top, ["push", "--quiet", "--no-verify", remote, ...chunk.map((r) => `--force-with-lease=${r.ref}:${r.oid}`), ...chunk.map((r) => `:${r.ref}`)]);
        deleted = [...deleted, ...chunk];
      } catch (e) { error = e instanceof Error ? e.message : "push failed"; }
    }
    let left: number | null = null;
    try { left = remoteRefs(p.top, remote).length; } catch { /* unknown */ }
    return { remote, deleted: counted(deleted), left, ...(error ? { error } : {}) };
  });

  const uninstalled = opts.keepSetup ? null : uninstall(p.top, { instructions: opts.instructions });
  return { file, here: counted(refs), remotes, uninstalled };
}

export interface Backup { file: string; name: string; created: string; says: string }

/** This project's backups, newest first. Read from each file's list of refs, so nothing is imported. */
export function backups(given: string): Backup[] {
  const p = project(given);
  const dir = backupDir();
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".bundle")); } catch { return []; }
  return names.flatMap((name) => {
    const file = join(dir, name);
    let heads: Ref[];
    try { heads = bundleHeads(p.top, file); } catch { return []; }
    if (!heads.some((h) => h.ref === `${SETTINGS_REF}${p.id}`)) return [];
    return [{ file, name, created: statSync(file).mtime.toISOString(), says: counted(heads.filter((h) => !h.ref.startsWith(SETTINGS_REF))) }];
  }).sort((a, b) => b.created.localeCompare(a.created));
}

interface Restored {
  file: string;
  added: string;
  same: number;
  /** Refs that are different here than in the backup, left as they are here. */
  kept: string[];
  settings: string[];
  settingsKept: string[];
  setup: string[] | null;
  /** How to put the records back on each remote they were deleted from. */
  pushBack: string[];
  /** Whether ANVC is still off in this folder. */
  off: boolean;
}

/**
 * Brings back a backup's refs and settings. Anything that is different here
 * than in the backup is left as it is here and named, so nothing newer is
 * overwritten. With `setup`, puts back what setup had changed.
 */
export function restore(given: string, file: string, opts: { setup?: boolean } = {}): Restored {
  const p = project(given);
  const path = existsSync(file) ? resolve(file) : join(backupDir(), file);
  if (!existsSync(path)) throw new Error(`there's no backup at ${file}`);
  git(p.top, ["bundle", "verify", "--quiet", path]);
  const heads = bundleHeads(p.top, path);
  const settingsHead = heads.find((h) => h.ref.startsWith(SETTINGS_REF));
  if (!settingsHead) throw new Error(`${path} isn't an ANVC backup`);
  if (settingsHead.ref !== `${SETTINGS_REF}${p.id}`) throw new Error(`${path} is a backup of another project`);
  // Stores the objects; no ref changes until the transaction below.
  git(p.top, ["bundle", "unbundle", path]);
  const meta = JSON.parse(git(p.top, ["cat-file", "blob", settingsHead.oid])) as Meta;

  const now = new Map(readRefs(p.top, "refs/").map((r) => [r.ref, r.oid]));
  const refs = heads.filter((h) => h !== settingsHead && ANVC_REF.test(h.ref));
  const add = refs.filter((r) => !now.has(r.ref));
  const kept = refs.filter((r) => now.has(r.ref) && now.get(r.ref) !== r.oid).map((r) => r.ref);
  // `create` fails if the ref appeared meanwhile, and then none are written.
  if (add.length) git(p.top, ["update-ref", "--stdin"], { input: add.map((r) => `create ${r.ref} ${r.oid}\n`).join("") });

  const settings: string[] = [], settingsKept: string[] = [];
  for (const [rel, text] of Object.entries(meta.settings ?? {})) {
    const target = resolve(p.settings, rel);
    if (below(p.settings, target) === null) continue;
    if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); settings.push(rel); }
    else if (readFileSync(target, "utf8") !== text) settingsKept.push(rel);
  }

  const pushBack = (meta.removedFrom ?? []).map((remote) => {
    const fetched = refs.some((r) => r.ref.startsWith(`refs/remotes/${remote}/anvc/`));
    return `git push ${remote} 'refs/anvc/*:refs/anvc/*'${fetched ? ` 'refs/remotes/${remote}/anvc/*:refs/anvc/*'` : ""}`;
  });
  const setup = opts.setup ? setUpAgain(p, meta.setup) : null;
  return {
    file: path, added: counted(add), same: refs.length - add.length - kept.length, kept, settings, settingsKept,
    setup, pushBack, off: !folderOn(p.root),
  };
}

/** What setup had changed here, changed back: the folder's switch, git config, the pre-push check and the agents' hooks. */
function setUpAgain(p: ReturnType<typeof project>, s: Setup): string[] {
  const done: string[] = [];
  setFolder(p.root, true);
  done.push("ANVC is on for this folder");
  if (isLocalOnly(p.top)) done.push("local only is on, so git push and fetch were left as they are");
  else for (const remote of s.remotes.filter((r) => remoteNames(p.top).includes(r))) {
    configureRemote(p.top, remote);
    done.push(`records travel with git push and fetch on ${remote}`);
  }
  if (s.privateRemote) { git(p.top, ["config", "anvc.privateRemote", s.privateRemote]); done.push(`anvc sync uses ${s.privateRemote} again`); }
  if (s.prePush) {
    try { done.push(installPrePush(p.top)); } catch (error) { done.push(error instanceof Error ? error.message : "the pre-push check couldn't be installed"); }
  }
  if (s.agents.length) {
    if (!existsSync(SETUP)) done.push(`hooks for ${s.agents.join(", ")} weren't put back; run setup for them`);
    else {
      const run = spawnSync("bun", [SETUP, "--repo", p.top, "--agent", s.agents.join(","), "--no-remote"], { encoding: "utf8", windowsHide: true });
      done.push(run.status === 0 ? `setup ran again for ${s.agents.join(", ")}` : `setup for ${s.agents.join(", ")} failed: ${(run.stderr || run.stdout).trim().split("\n").at(-1)}`);
    }
  }
  return done;
}

/** `anvc remove [--remote NAME|all] [--yes] [--keep-setup] [--instructions]` */
export function removeCommand(repo: string, argv: string[]): number {
  const which = flag(argv, "remote");
  if (has(argv, "remote") && !which) { console.error("usage: anvc remove --remote <name|all>. Nothing was changed."); return 2; }
  let targets: Array<{ remote: string; refs: Ref[] }>;
  try {
    const all = which === "all";
    targets = (all ? remoteNames(repo) : which ? [which] : []).map((remote) => ({ remote, refs: remoteRefs(repo, remote) }));
    if (all) targets = targets.filter((t) => t.refs.length);
  } catch (error) { console.error(`${said(error)}. Nothing was changed.`); return 1; }
  for (const t of targets) {
    const url = gitOrNull(repo, ["remote", "get-url", "--push", t.remote]);
    console.log(t.refs.length
      ? `This deletes ${t.refs.length} ANVC ref${t.refs.length === 1 ? "" : "s"} on ${t.remote} (${url}): ${counted(t.refs)}.`
      : `${t.remote} holds no ANVC refs.`);
  }
  if (which === "all" && !targets.length) console.log("No remote holds ANVC refs.");
  if (targets.some((t) => t.refs.length) && !has(argv, "yes")) {
    if (!process.stdin.isTTY) {
      console.error("Deleting on a remote needs --yes when there's no terminal to ask in. Nothing was changed.");
      return 2;
    }
    if (!/^y(es)?$/i.test((prompt("Delete them there? [y/N]") ?? "").trim())) { console.log("Nothing was changed."); return 1; }
  }
  // Records this clone pushed or fetched are on a remote too, unless it was named.
  const pushed = !which && readRefs(repo, "refs/").some((r) => /^refs\/(remotes\/[^/]+\/)?anvc\//.test(r.ref));
  let done: Removed;
  try {
    done = remove(repo, { remotes: targets.filter((t) => t.refs.length).map((t) => t.remote), keepSetup: has(argv, "keep-setup"), instructions: has(argv, "instructions") });
  } catch (error) { console.error(said(error)); return 1; }
  console.log(`Backed up ${done.here}, with this project's settings, to\n  ${done.file}\n`);
  console.log(`Deleted ${done.here} in this clone.`);
  for (const r of done.remotes) {
    console.log(r.error
      ? `Deleted ${r.deleted} on ${r.remote}, then it failed: ${r.error}`
      : `Deleted ${r.deleted} on ${r.remote}.${r.left ? ` ${r.left} ${r.left === 1 ? "is" : "are"} still there; run this again to delete them.` : ""}`);
  }
  if (done.remotes.length) console.log("Anyone who already fetched them keeps their copy.");
  if (pushed) console.log("Records already pushed stay on the remote. To delete them there too: anvc remove --remote all");
  if (done.uninstalled) {
    console.log(`\nANVC removed from ${gitOrNull(repo, ["rev-parse", "--show-toplevel"]) ?? repo}.`);
    for (const line of done.uninstalled.removed) console.log(`  ✓ ${line}`);
    for (const line of done.uninstalled.kept) console.log(`  · kept: ${line}`);
  }
  console.log(`\nTo put it all back: anvc restore ${done.file}${done.uninstalled ? " --setup" : ""}`);
  return done.remotes.some((r) => r.error) ? 1 : 0;
}

/** `anvc restore [<file>] [--setup]`: lists this project's backups, or restores one. */
export function restoreCommand(repo: string, argv: string[], file: string | undefined): number {
  try {
    if (!file) {
      const list = backups(repo);
      if (!list.length) { console.log(`No backups of this project in ${backupDir()}.`); return 0; }
      console.log("Backups of this project, newest first:\n");
      for (const b of list) console.log(`  ${b.file}\n    ${new Date(b.created).toLocaleString()} · ${b.says}`);
      console.log("\nTo restore one: anvc restore <file>");
      return 0;
    }
    const done = restore(repo, file, { setup: has(argv, "setup") });
    const files = done.settings.length;
    console.log(`Restored ${done.added}${files ? `, with ${files} settings file${files === 1 ? "" : "s"},` : ""} from\n  ${done.file}`);
    if (done.same) console.log(`  · ${done.same} ${done.same === 1 ? "was" : "were"} already here`);
    if (done.kept.length) {
      const one = done.kept.length === 1;
      console.log(`  · ${done.kept.length} changed after the backup, so ${one ? "it's" : "they're"} kept as ${one ? "it is" : "they are"} here: ${done.kept.slice(0, 5).join(", ")}${done.kept.length > 5 ? ` and ${done.kept.length - 5} more` : ""}`);
      console.log(`    To take the backup's copy of one: git fetch ${done.file} '+<ref>:<ref>'`);
    }
    if (done.settingsKept.length) console.log(`  · settings that changed after the backup, kept as they are here: ${done.settingsKept.join(", ")}`);
    for (const line of done.setup ?? []) console.log(`  ✓ ${line}`);
    if (done.off) console.log(`\nANVC is off in this folder. To put back what setup changed: anvc restore ${done.file} --setup`);
    if (done.pushBack.length) console.log(`\nTo put the records back on the remote:\n${done.pushBack.map((c) => `  ${c}`).join("\n")}`);
    return 0;
  } catch (error) {
    console.error(said(error));
    return 1;
  }
}
