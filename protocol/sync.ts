/**
 * Your private history on every machine you work from.
 *
 * Private records, the raw log and the kept session copies never go to the
 * team's remote. Switching machines left all of them behind. This syncs them
 * through a remote only you can read, named in `git config anvc.privateRemote`
 * and dedicated to this project.
 *
 * Records travel as the refs they already are. The raw log and the session
 * copies are files, so each is stored as a blob under a ref named for the
 * machine that wrote it, and written back out as a file on the others. Every
 * machine only ever overwrites its own refs.
 *
 * Pointing this at the team's remote would publish everything private, so a
 * remote whose URL matches any remote the team's records travel through is
 * refused.
 */
import { isLocalOnly, LOCAL_ONLY_REFUSAL } from "./localonly";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { git, gitOrNull, readRefs } from "./git";
import { captureRoot, isRepo, legacyKey, repoKey } from "./rawlog";
import { keptRoot } from "./keep";

const RAW = "refs/anvc-raw/";
const KEPT = "refs/anvc-kept/";
/** Which project a private remote holds; see claimRemote. */
const PROJECT = "refs/anvc-meta/project";
/** Refs that only ever go to the private remote. The pre-push check holds them to that. */
export const PRIVATE_REFS = ["refs/anvc-private/", RAW, KEPT, "refs/anvc-meta/"];
const machine = () => (process.env.ANVC_MACHINE ?? hostname()).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "machine";

/**
 * Every URL a remote pushes to, and with `fetch` the ones it fetches from too.
 * A push goes to remote.<name>.pushurl when one is set, so reading the fetch
 * URL alone checked a different repository from the one that was sent to.
 */
const urlsOf = (repo: string, remote: string, fetch = false) => [
  ...(gitOrNull(repo, ["remote", "get-url", "--push", "--all", remote]) ?? "").split("\n"),
  ...(fetch ? (gitOrNull(repo, ["remote", "get-url", "--all", remote]) ?? "").split("\n") : []),
].filter(Boolean);

/**
 * A repository's URL in one spelling, so two spellings of it compare equal:
 * no scheme, user, port or www., no trailing .git or slash, and the scp form
 * git@host:path read as host/path. ssh://git@github.com/org/repo.git,
 * https://user@www.github.com/org/repo/ and git@github.com:/org/repo all
 * passed as a different repository from https://github.com/org/repo.
 */
export function repoUrlKey(url: string): string {
  let u = url.trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(u);
  if (scheme) u = u.slice(scheme[0].length).replace(/^[^/]*@/, "").replace(/^([^/:]*):\d*(?=\/|$)/, "$1");
  else if (/^[^/]*:/.test(u)) u = u.replace(/^[^/@]*@/, "").replace(":", "/");
  return u.replace(/^www\./, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/** The remote's URL when it is safe to sync private history through, or why not. */
export function checkPrivateRemote(repo: string, remote: string): { ok: true; url: string } | { ok: false; reason: string } {
  const urls = urlsOf(repo, remote);
  if (!urls.length) return { ok: false, reason: `no remote named ${remote}` };
  const anvcRemote = gitOrNull(repo, ["config", "--get", "anvc.remote"]);
  const isTeam = (name: string) => name === "origin" || anvcRemote === name
    || (gitOrNull(repo, ["config", "--get-all", `remote.${name}.push`]) ?? "").includes("refs/anvc/");
  const team = new Set((gitOrNull(repo, ["remote"]) ?? "").split("\n")
    .filter((name) => name && name !== remote && isTeam(name))
    .flatMap((name) => urlsOf(repo, name, true)).map(repoUrlKey));
  if (isTeam(remote) || urls.some((u) => team.has(repoUrlKey(u)))) {
    return { ok: false, reason: `${remote} is the same repository the team's records go to; syncing there would share everything private` };
  }
  return { ok: true, url: urls[0]! };
}

/** Files under a folder, as [name, path]. */
const files = (dir: string, match: (n: string) => boolean) => {
  try { return readdirSync(dir).filter(match).map((n) => [n, join(dir, n)] as const); } catch { return []; }
};

/** Stores this machine's raw log and session copies under refs, so they can travel. */
function stage(repo: string, root: string): number {
  const me = machine();
  let staged = 0;
  const store = (ref: string, oid: string) => {
    if (gitOrNull(repo, ["rev-parse", "--verify", "--quiet", ref]) !== oid) {
      git(repo, ["update-ref", ref, oid]);
      staged++;
    }
  };
  // Only this machine's own files; ones fetched from another machine carry
  // its name and are that machine's to update. Only this repository's rows,
  // too: a folder can hold another project's (the folder name before it
  // carried a hash), and every row that leaves has to be this project's.
  const days = new Map<string, string[]>();
  const here = isRepo(root);
  for (const key of [repoKey(root), legacyKey(root)]) {
    for (const [name, path] of files(join(captureRoot(), key), (n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
      const rows = readFileSync(path, "utf8").split("\n").filter((line) => {
        try { return here((JSON.parse(line) as { repo?: unknown }).repo); } catch { return false; }
      });
      if (rows.length) days.set(name, [...(days.get(name) ?? []), ...rows]);
    }
  }
  for (const [name, rows] of days) {
    store(`${RAW}${me}/${name.slice(0, -6)}`, git(repo, ["hash-object", "-w", "--stdin"], { input: `${rows.join("\n")}\n` }));
  }
  for (const [agent, dir] of files(join(keptRoot(), repoKey(root)), () => true)) {
    for (const [name, path] of files(dir, (n) => /\.jsonl(\.gz|\.zst)?$/.test(n) && !n.includes(".from-"))) {
      store(`${KEPT}${me}/${agent}/${name.replace(/\./g, "_")}`, git(repo, ["hash-object", "-w", path]));
    }
  }
  return staged;
}

/** Writes other machines' raw log and session copies out as files here. */
function unstage(repo: string, root: string): number {
  const me = machine();
  let written = 0;
  for (const { ref, oid } of readRefs(repo, RAW)) {
    const [host, day] = ref.slice(RAW.length).split("/");
    if (!host || !day || host === me) continue;
    const path = join(captureRoot(), repoKey(root), `${day}.from-${host}.jsonl`);
    // Each row names the repository by its path on the machine that wrote
    // it, which is rarely this one's; rewritten, so this machine's queries
    // find them. One file holds one project, so only rows naming the path
    // most of them name are rewritten; any other row, from a copy staged
    // before rows were filtered, is dropped rather than relabelled as ours.
    const lines = git(repo, ["cat-file", "blob", oid]).split("\n");
    const counts = new Map<string, number>();
    for (const line of lines) {
      try { const r = (JSON.parse(line) as { repo?: unknown }).repo; if (typeof r === "string") counts.set(r, (counts.get(r) ?? 0) + 1); } catch { /* skipped */ }
    }
    const project = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const body = lines.flatMap((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const from = typeof row.repo === "string" ? row.repo : null;
        if (from !== project) return [];
        if (!from || from === root) return [line];
        for (const key of ["repo", "cwd", "path"]) {
          const v = row[key];
          if (typeof v === "string" && (v === from || v.startsWith(`${from}/`))) row[key] = root + v.slice(from.length);
        }
        return [JSON.stringify(row)];
      } catch { return []; }
    }).join("\n");
    if (existsSync(path) && readFileSync(path, "utf8") === `${body}\n`) continue;
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${body}\n`, { mode: 0o600 });
    written++;
  }
  for (const { ref, oid } of readRefs(repo, KEPT)) {
    const [host, agent, flat] = ref.slice(KEPT.length).split("/");
    if (!host || !agent || !flat || host === me) continue;
    const name = flat.replace(/_jsonl/, ".jsonl").replace(/_(gz|zst)$/, ".$1");
    const path = join(keptRoot(), repoKey(root), agent, name.replace(/\.jsonl/, `.from-${host}.jsonl`));
    // The other machine copies a session again every few turns while it runs,
    // so a later sync can fetch a newer copy than the one written here.
    const copy = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", oid], { stdout: "pipe", windowsHide: true }).stdout;
    if (existsSync(path) && readFileSync(path).equals(copy)) continue;
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, copy, { mode: 0o600 });
    written++;
  }
  return written;
}

interface SyncResult { remote: string; pushed: boolean; fetched: boolean; staged: number; written: number; errors: string[] }

/**
 * What makes this project this project on every machine: its first commit.
 * Paths differ between machines; the root commit of a clone doesn't.
 */
function projectId(repo: string): string | null {
  return gitOrNull(repo, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n").filter(Boolean).sort()[0] ?? null;
}

/**
 * Refuses a private remote that already holds another project's history.
 * Nothing kept one remote to one project: two projects synced through the
 * same one fetched each other's private records into their own logs.
 */
function claimRemote(repo: string, remote: string): void {
  const id = projectId(repo);
  if (!id) throw new Error("This repository has no commits yet, so sync can't tell it apart from another project. Commit once, then sync.");
  const mine = git(repo, ["hash-object", "-w", "--stdin"], { input: `${id}\n` });
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-remote", remote, PROJECT], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const theirs = listed.stdout.toString().trim().split(/\s+/)[0] ?? "";
  if (theirs && theirs !== mine) {
    throw new Error(`${remote} already holds another project's private history. Use a separate private remote for each project.`);
  }
  git(repo, ["update-ref", PROJECT, mine]);
}

export function sync(repo: string, root: string, remote: string): SyncResult {
  if (isLocalOnly(repo)) throw new Error(LOCAL_ONLY_REFUSAL);
  const check = checkPrivateRemote(repo, remote);
  if (!check.ok) throw new Error(check.reason);
  claimRemote(repo, remote);
  const errors: string[] = [];
  const staged = stage(repo, root);
  const me = machine();
  // Records are written once and never change, so they are not forced; this
  // machine's own raw log and copies grow, so its refs are.
  const fetch = Bun.spawnSync(["git", "-C", repo, "fetch", "--quiet", remote,
    "refs/anvc-private/*:refs/anvc-private/*", `+${RAW}*:${RAW}*`, `+${KEPT}*:${KEPT}*`], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (!fetch.success) errors.push(fetch.stderr.toString().trim().split("\n").at(-1) ?? "fetch failed");
  // A fetch overwrote this machine's refs with the remote's older copies;
  // stage again so what is pushed is what is on disk here.
  stage(repo, root);
  const push = Bun.spawnSync(["git", "-C", repo, "push", "--quiet", remote, `${PROJECT}:${PROJECT}`,
    "refs/anvc-private/*:refs/anvc-private/*", `+${RAW}${me}/*:${RAW}${me}/*`, `+${KEPT}${me}/*:${KEPT}${me}/*`], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (!push.success) errors.push(push.stderr.toString().trim().split("\n").at(-1) ?? "push failed");
  const written = unstage(repo, root);
  return { remote, pushed: push.success, fetched: fetch.success, staged, written, errors };
}

export const privateRemote = (repo: string): string | null =>
  gitOrNull(repo, ["config", "--get", "anvc.privateRemote"]) || null;
