/**
 * Private history on a second machine, through a remote only you can read.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureFile, repoKey, samePath } from "../protocol/rawlog";
import { appendRecord, readRecords, ulid, type CheckpointRecord } from "../protocol/record";
import { checkPrivateRemote, repoUrlKey } from "../protocol/sync";
import { git, gitRepo, rawRows, tmp } from "./helpers";

const CLI = resolve(import.meta.dir, "../protocol/cli.ts");

const commitAs = (repo: string, message: string) => Bun.spawnSync(
  ["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message],
  { env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });

function machine(name: string, privateUrl: string, teamUrl: string) {
  const repo = gitRepo();
  const home = tmp(`anvc-sync-${name}-home-`);
  // Two clones of one project share its first commit, which is how sync tells
  // the project apart from another. Same content and dates, same commit.
  commitAs(repo, "base");
  git(repo, "remote", "add", "origin", teamUrl);
  git(repo, "remote", "add", "mine", privateUrl);
  const env = { ...process.env, ANVC_MACHINE: name, ANVC_CAPTURE_DIR: join(home, "capture"), ANVC_KEPT_DIR: join(home, "kept") };
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args, "--repo", repo], { env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  return { repo, home, env, cli };
}

test("a second machine gets the private records, the raw log and the session copies", async () => {
  const priv = gitRepo({ bare: true });
  const team = gitRepo({ bare: true });
  const a = machine("laptop", priv, team);
  const b = machine("desktop", priv, team);
  const record = {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) }, session: { agent: "claude-code", run_id: "s" },
    intent: { goal: "Try the in-memory cache" }, outcome: { status: "abandoned", recheck: null }, ts: new Date().toISOString(),
  } as CheckpointRecord;
  appendRecord(a.repo, record, { tier: "private" });
  const day = new Date().toISOString().slice(0, 10);
  const raw = captureFile(a.repo, day, join(a.home, "capture"));
  mkdirSync(join(raw, ".."), { recursive: true });
  writeFileSync(raw, `${JSON.stringify({ anvc_capture: 0, event: "Stop", session_id: "s", repo: a.repo })}\n`);
  const kept = join(a.home, "kept", repoKey(a.repo), "claude-code");
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, "s1.jsonl.gz"), Bun.gzipSync(Buffer.from('{"type":"user"}\n')));

  expect(a.cli("sync", "--remote", "mine").code).toBe(0);
  const synced = b.cli("sync", "--remote", "mine");
  expect(synced.code).toBe(0);
  expect(synced.out).toContain("2 files from your other machines");

  expect(readRecords(b.repo).map(([, r]) => r.id)).toEqual([record.id]);
  expect(readdirSync(join(b.home, "capture", repoKey(b.repo)))).toEqual([`${day}.from-laptop.jsonl`]);
  // Rows name this machine's copy of the repository, so its queries find them.
  const [row] = rawRows(join(b.home, "capture"));
  expect(samePath(row!.repo)).toBe(samePath(b.repo));
  expect(existsSync(join(b.home, "kept", repoKey(b.repo), "claude-code", "s1.from-laptop.jsonl.gz"))).toBe(true);
  // Nothing private went to the team's remote.
  expect(Bun.spawnSync(["git", "-C", team, "for-each-ref"]).stdout.toString()).toBe("");
}, 30_000);

test("a session copy that grew on the other machine is written again here", async () => {
  const priv = gitRepo({ bare: true });
  const team = gitRepo({ bare: true });
  const a = machine("laptop", priv, team);
  const b = machine("desktop", priv, team);
  const kept = join(a.home, "kept", repoKey(a.repo), "claude-code");
  mkdirSync(kept, { recursive: true });
  const copy = (text: string) => writeFileSync(join(kept, "s1.jsonl.gz"), Bun.gzipSync(Buffer.from(text)));
  const mirror = () => new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(b.home, "kept", repoKey(b.repo), "claude-code", "s1.from-laptop.jsonl.gz"))));

  copy('{"type":"user"}\n');
  expect(a.cli("sync", "--remote", "mine").code).toBe(0);
  expect(b.cli("sync", "--remote", "mine").code).toBe(0);
  expect(mirror()).toBe('{"type":"user"}\n');

  // The session went on after the first sync, and the stop hook copied it again.
  copy('{"type":"user"}\n{"type":"assistant"}\n');
  expect(a.cli("sync", "--remote", "mine").code).toBe(0);
  expect(b.cli("sync", "--remote", "mine").code).toBe(0);
  expect(mirror()).toBe('{"type":"user"}\n{"type":"assistant"}\n');
}, 30_000);

test("the team's remote is refused as a private remote", async () => {
  const team = gitRepo({ bare: true });
  const a = machine("laptop", team, team);
  const r = a.cli("sync", "--remote", "mine");
  expect(r.code).toBe(1);
  expect(r.out).toContain("same repository the team's records go to");
  expect(Bun.spawnSync(["git", "-C", a.repo, "config", "--get", "anvc.privateRemote"]).stdout.toString()).toBe("");
});

test("a private remote that holds one project's history refuses another's", async () => {
  const priv = gitRepo({ bare: true });
  const team = gitRepo({ bare: true });
  const a = machine("laptop", priv, team);
  const other = machine("laptop", priv, team);
  // A different project: its first commit is its own.
  rmSync(join(other.repo, ".git"), { recursive: true, force: true });
  git(other.repo, "init", "-q");
  commitAs(other.repo, "another project");
  git(other.repo, "remote", "add", "origin", team);
  git(other.repo, "remote", "add", "mine", priv);

  expect(a.cli("sync", "--remote", "mine").code).toBe(0);
  const r = other.cli("sync", "--remote", "mine");
  expect(r.code).toBe(1);
  expect(r.out).toContain("already holds another project's private history");
});

test("the team's repository is refused however its URL is spelled, and wherever the push goes", async () => {
  const team = "https://github.com/org/repo";
  for (const spelling of [
    "ssh://git@github.com/org/repo.git", "https://user@github.com/org/repo", "git@github.com:/org/repo",
    "https://www.github.com/org/repo/", "ssh://git@github.com:22/org/repo.git", "git@GitHub.com:org/repo.git",
  ]) {
    const repo = gitRepo();
    git(repo, "remote", "add", "origin", team);
    git(repo, "remote", "add", "mine", spelling);
    expect({ spelling, ok: checkPrivateRemote(repo, "mine").ok }).toEqual({ spelling, ok: false });
  }
  const repo = gitRepo();
  git(repo, "remote", "add", "origin", team);
  git(repo, "remote", "add", "mine", "https://github.com/me/private-history");
  expect(checkPrivateRemote(repo, "mine").ok).toBe(true);
  // Fetched from a private repository, pushed to the team's.
  git(repo, "remote", "set-url", "--push", "mine", "git@github.com:org/repo.git");
  expect(checkPrivateRemote(repo, "mine").ok).toBe(false);
  // The team's remote itself.
  expect(checkPrivateRemote(repo, "origin").ok).toBe(false);
  // Different repositories stay different.
  expect(repoUrlKey("git@github.com:org/repo-private.git")).not.toBe(repoUrlKey(team));
  expect(repoUrlKey("file:///srv/git/repo.git")).toBe(repoUrlKey("/srv/git/repo"));
});
