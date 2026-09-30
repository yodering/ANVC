/**
 * anvc remove and anvc restore, against a temp clone and a local bare remote.
 *
 * Remove deletes history on a remote that other people fetch from, so what it
 * must never do is checked first: delete without a backup that verifies, or
 * touch anything on the remote besides ANVC's refs.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { folderOn } from "../protocol/folders";
import { configureRemote, readRefs } from "../protocol/git";
import { writeRecord } from "../protocol/record";
import { backup, backups, removalPlan, remove, restore } from "../protocol/remove";
import { cli, git, gitRepo, rec, served, setEnv, tmp, uiFetch, uiPost } from "./helpers";

const ANVC = /^refs\/(remotes\/[^/]+\/)?anvc(-[a-z]+)?\//;
const anvcRefs = (repo: string) => readRefs(repo, "refs/").filter((r) => ANVC.test(r.ref));
const blob = (repo: string, text: string) => {
  const file = join(tmp("anvc-blob-"), "b");
  writeFileSync(file, text);
  return git(repo, "hash-object", "-w", file);
};

/** A clone with shared, private and raw-log refs and settings, and a remote holding its branch, its shared records and one record this clone never fetched. */
function project() {
  setEnv({ ANVC_STATE_HOME: tmp("anvc-remove-home-") });
  const bare = gitRepo({ bare: true });
  const repo = gitRepo({ commit: true });
  git(repo, "remote", "add", "origin", bare);
  configureRemote(repo, "origin");
  writeRecord(repo, rec({ intent: { goal: "shared one" } }), 1);
  writeRecord(repo, rec({ intent: { goal: "private one" } }), 2, "private");
  git(repo, "update-ref", "refs/anvc-raw/laptop/2026-09-30", blob(repo, '{"row":1}\n'));
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main", "refs/anvc/*:refs/anvc/*");
  const theirs = blob(bare, '{"teammate":1}\n');
  git(bare, "update-ref", "refs/anvc/claude-code/theirs/0000000001-01M0000000000000000000000", theirs);
  const settings = join(repo, ".git", "anvc");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "policy.json"), '{"preset":"public"}\n');
  writeFileSync(join(settings, "local-off"), "off here\n");
  return { repo, bare, settings, theirs };
}

test("the backup holds every ANVC ref and the settings, verifies, and only its owner can read it", () => {
  const { repo } = project();
  const before = anvcRefs(repo);
  // Shared, private, raw log, and the copy git push left under refs/remotes/origin.
  expect(before.length).toBe(4);
  const { file } = backup(repo);
  expect(file.startsWith(join(process.env.ANVC_STATE_HOME!, "backups"))).toBe(true);
  expect(file).toMatch(/anvc-repo-[^/]+-\d{4}-\d{2}-\d{2}-\d{6}\.bundle$/);
  // Windows has no POSIX file modes.
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  git(repo, "bundle", "verify", "--quiet", file);
  const heads = git(repo, "bundle", "list-heads", file);
  for (const r of before) expect(heads).toContain(`${r.oid} ${r.ref}`);
  // The settings ride along under a ref of their own, which is never left in the clone.
  expect(heads).toMatch(/ refs\/anvc-backup\/[0-9a-f]{40}$/m);
  expect(readRefs(repo, "refs/anvc-backup/")).toEqual([]);
  expect(backups(repo).map((b) => b.file)).toEqual([file]);
});

test("nothing is deleted, here or on the remote, when the backup can't be written", () => {
  const { repo, bare, settings } = project();
  // Where the backups folder should be, a file: mkdir fails.
  const home = tmp("anvc-remove-broken-");
  writeFileSync(join(home, "backups"), "not a folder");
  setEnv({ ANVC_STATE_HOME: home });
  const here = anvcRefs(repo), there = anvcRefs(bare);
  expect(() => remove(repo, { remotes: ["origin"] })).toThrow(/Nothing was deleted/);
  // The remote's records were fetched for the backup; nothing that was here went.
  expect(anvcRefs(repo)).toEqual(expect.arrayContaining(here));
  expect(anvcRefs(bare)).toEqual(there);
  expect(existsSync(join(settings, "policy.json"))).toBe(true);
  expect(git(repo, "config", "--get-all", "remote.origin.push")).toContain("refs/anvc/*");
});

test("the remote loses exactly its ANVC refs, including ones this clone never fetched, and keeps its branches", () => {
  const { repo, bare, settings, theirs } = project();
  const done = remove(repo, { remotes: ["origin"] });
  expect(readRefs(bare, "refs/").map((r) => r.ref)).toEqual(["refs/heads/main"]);
  expect(done.remotes).toEqual([{ remote: "origin", deleted: "2 records", left: 0 }]);
  expect(anvcRefs(repo)).toEqual([]);
  // The teammate's record, fetched before anything was deleted, is in the backup.
  expect(git(repo, "bundle", "list-heads", done.file)).toContain(`${theirs} refs/remotes/origin/anvc/claude-code/theirs/`);
  // And setup's changes are gone: git config and the settings.
  expect(existsSync(settings)).toBe(false);
  expect(() => git(repo, "config", "--get-all", "remote.origin.push")).toThrow();
});

test("restore brings back the refs and settings, and with --setup what setup changed", () => {
  const { repo, settings } = project();
  const { file } = remove(repo, { remotes: ["origin"] });
  const removedHere = readRefs(repo, "refs/");
  expect(removedHere.some((r) => ANVC.test(r.ref))).toBe(false);

  const out = cli(repo, "restore", file);
  expect(out.code).toBe(0);
  // The shared and private ones, and the teammate's, fetched before it was deleted there.
  expect(out.out).toContain("Restored 3 records and 1 other ANVC ref, with 2 settings files, from");
  expect(out.out).toContain("ANVC is off in this folder");
  expect(out.out).toContain(`git push origin 'refs/anvc/*:refs/anvc/*' 'refs/remotes/origin/anvc/*:refs/anvc/*'`);
  expect(anvcRefs(repo).length).toBe(5);
  expect(readFileSync(join(settings, "policy.json"), "utf8")).toBe('{"preset":"public"}\n');
  expect(readFileSync(join(settings, "local-off"), "utf8")).toBe("off here\n");

  // Again with --setup: every ref is already here, and setup's changes come back.
  const again = restore(repo, file, { setup: true });
  expect(again.same).toBe(5);
  expect(folderOn(repo)).toBe(true);
  expect(git(repo, "config", "--get-all", "remote.origin.push")).toContain("refs/anvc/*:refs/anvc/*");
  expect(git(repo, "config", "--get-all", "remote.origin.fetch")).toContain("+refs/anvc/*:refs/remotes/origin/anvc/*");
});

test("restore --setup runs setup again for the agents that were set up here", () => {
  const { repo } = project();
  const hooks = join(repo, ".claude", "settings.local.json");
  const setup = Bun.spawnSync(["bun", resolve(import.meta.dir, "../scripts/setup.ts"), "--repo", repo, "--agent", "claude-code", "--no-instructions"], { stdout: "pipe", stderr: "pipe" });
  expect(setup.exitCode).toBe(0);
  expect(readFileSync(hooks, "utf8")).toContain("emitters/claude-code/");
  expect(removalPlan(repo).setup).toContain("Take ANVC's entries out of .claude/settings.local.json");

  const { file } = remove(repo);
  expect(existsSync(hooks)).toBe(false);
  expect(restore(repo, file, { setup: true }).setup).toContain("setup ran again for claude-code");
  expect(readFileSync(hooks, "utf8")).toContain("emitters/claude-code/");
}, 30_000);

test("a ref that changed since the backup is left as it is, and restore says so", () => {
  const { repo } = project();
  const { file } = remove(repo, { keepSetup: true });
  const newer = blob(repo, '{"row":1}\n{"row":2}\n');
  git(repo, "update-ref", "refs/anvc-raw/laptop/2026-09-30", newer);
  const out = cli(repo, "restore", file);
  expect(out.out).toContain("1 changed after the backup, so it's kept as it is here: refs/anvc-raw/laptop/2026-09-30");
  expect(git(repo, "rev-parse", "refs/anvc-raw/laptop/2026-09-30")).toBe(newer);
  // The rest came back.
  expect(anvcRefs(repo).length).toBe(4);
});

test("without a terminal, deleting on a remote needs --yes, and nothing changes without it", () => {
  const { repo, bare } = project();
  const here = anvcRefs(repo), there = anvcRefs(bare);
  const refused = cli(repo, "remove", "--remote", "origin");
  expect(refused.code).toBe(2);
  expect(refused.out).toContain("This deletes 2 ANVC refs on origin");
  expect(refused.out).toContain("needs --yes");
  expect(anvcRefs(repo)).toEqual(here);
  expect(anvcRefs(bare)).toEqual(there);
  expect(backups(repo)).toEqual([]);

  const done = cli(repo, "remove", "--remote", "origin", "--yes");
  expect(done.code).toBe(0);
  expect(done.out).toContain("Backed up 3 records and 1 other ANVC ref, with this project's settings, to");
  expect(done.out).toContain("Deleted 2 records on origin.");
  expect(anvcRefs(bare)).toEqual([]);
});

test("the page's routes refuse a request from anywhere else, and deleting on a remote needs its name typed", async () => {
  const { repo, bare } = project();
  const here = anvcRefs(repo), there = anvcRefs(bare);
  await served(repo, process.env, async (origin) => {
    const post = (path: string, body: object, headers?: Record<string, string>) => uiPost(`${origin}${path}`, body, headers);
    expect((await post("/api/remove", {}, {})).status).toBe(403);
    expect((await post("/api/remove", {}, { "x-anvc": "1", origin: "https://example.com" })).status).toBe(403);
    expect((await post("/api/restore", { file: "x" }, {})).status).toBe(403);
    const wrong = await post("/api/remove", { remotes: ["origin"], confirm: "orign" });
    expect(wrong.status).toBe(400);
    expect(anvcRefs(repo)).toEqual(here);
    expect(anvcRefs(bare)).toEqual(there);

    const plan = await (await uiFetch(`${origin}/api/remove`)).json();
    // The shared record and the copy git push left under refs/remotes/origin are one.
    expect(plan.says).toBe("2 records and 1 other ANVC ref");
    expect(plan.remotes).toEqual([{ remote: "origin", url: bare, refs: 2, says: "2 records" }]);
    expect(plan.setup).toContain("Stop records going with git push and fetch on origin");

    const done = await (await post("/api/remove", { remotes: ["origin"], confirm: "origin" })).json();
    expect(done.file).toMatch(/\.bundle$/);
    expect(anvcRefs(bare)).toEqual([]);

    // Only a backup this project's list holds can be restored.
    expect((await post("/api/restore", { file: "/etc/passwd" })).status).toBe(400);
    const listed = await (await uiFetch(`${origin}/api/restore`)).json();
    expect(listed.backups.map((b: { file: string }) => b.file)).toEqual([done.file]);
    const restored = await (await post("/api/restore", { file: done.file })).json();
    expect(restored.restored.added).toBe("3 records and 1 other ANVC ref");
  });
}, 30_000);
