/**
 * Records have to travel, or the log is one developer's private diary.
 *
 * `refs/anvc/*` is outside the namespaces git syncs by default: a plain push
 * leaves records behind and a plain clone fetches none of them, so a teammate
 * sees an empty log and nothing tells them otherwise. That is a large part of
 * why git notes never caught on. `anvc init` writes the three refspecs that
 * make an ordinary push and fetch carry records.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, git, tmp } from "./helpers";

const refsOn = (repo: string, prefix: string) =>
  git(repo, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean);

/** An origin with one record pushed, plus a working clone. */
function origin(): { origin: string; work: string; dir: string } {
  const dir = tmp("anvc-dist-");
  const originPath = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", originPath);
  const work = join(dir, "work");
  git(dir, "clone", "-q", originPath, work);
  git(work, "commit", "-q", "--allow-empty", "-m", "base");
  git(work, "branch", "-M", "main");
  git(work, "push", "-q", "-u", "origin", "main");
  const oid = Bun.spawnSync(["git", "-C", work, "hash-object", "-w", "--stdin"],
    { stdin: new TextEncoder().encode('{"anvc":0}') }).stdout.toString().trim();
  git(work, "update-ref", "refs/anvc/s/000001", oid);
  return { origin: originPath, work, dir };
}

test("without init, a plain push leaves records behind", async () => {
  const { origin: remote, work } = origin();
  git(work, "push", "-q", "origin");
  // The branch arrives; the record does not. This is the failure that makes
  // the whole format look empty to everyone but its author.
  expect(refsOn(remote, "refs/heads/")).toHaveLength(1);
  expect(refsOn(remote, "refs/anvc/")).toHaveLength(0);
}, 60_000);

test("after init, a plain push carries records", async () => {
  const { origin: remote, work } = origin();
  expect(cli(work, "init").code).toBe(0);
  git(work, "branch", "wip");
  git(work, "push", "-q", "origin");
  expect(refsOn(remote, "refs/anvc/")).toEqual(["refs/anvc/s/000001"]);
  // Branches must still push: adding any remote.*.push replaces git's
  // default, so a config that named only our namespace would silently stop
  // pushing code. But only the current one — `wip` staying local is the
  // default this has to preserve.
  expect(refsOn(remote, "refs/heads/")).toEqual(["refs/heads/main"]);
}, 60_000);

test("a teammate fetches records into a remote-tracking namespace", async () => {
  const { origin: remote, work, dir } = origin();
  cli(work, "init");
  git(work, "push", "-q", "origin");

  const mate = join(dir, "mate");
  git(dir, "clone", "-q", remote, mate);
  expect(refsOn(mate, "refs/remotes/origin/anvc/")).toHaveLength(0);

  expect(cli(mate, "init").code).toBe(0);
  git(mate, "fetch", "-q", "origin");
  // Namespaced under refs/remotes, never onto local refs: a teammate's
  // record must not be indistinguishable from one written here.
  expect(refsOn(mate, "refs/remotes/origin/anvc/")).toHaveLength(1);
  expect(refsOn(mate, "refs/anvc/")).toHaveLength(0);
}, 60_000);

test("init takes back the refspec that pushed every branch", async () => {
  const { origin: remote, work } = origin();
  // What the first version of init wrote.
  git(work, "config", "--add", "remote.origin.push", "refs/heads/*:refs/heads/*");
  git(work, "config", "--add", "remote.origin.push", "refs/anvc/*:refs/anvc/*");

  expect(cli(work, "init").stdout).toContain("current branch, not every local branch");
  git(work, "branch", "wip");
  git(work, "push", "-q", "origin");
  expect(refsOn(remote, "refs/heads/")).toEqual(["refs/heads/main"]);
}, 60_000);

test("init is idempotent", async () => {
  const { work } = origin();
  cli(work, "init");
  const second = cli(work, "init");
  expect(second.stdout).toContain("nothing to do");

  const pushes = git(work, "config", "--get-all", "remote.origin.push").split("\n").filter(Boolean);
  expect(pushes).toHaveLength(2);
}, 60_000);
