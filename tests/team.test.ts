/**
 * Two people, two machines, one repository: what one agent abandoned has to
 * reach the other's.
 *
 * This is the case a local memory cannot serve, and it was broken while every
 * test passed. A teammate's records were fetched into `refs/remotes/origin/anvc/`
 * and every reader looked only in `refs/anvc/`, so they arrived and were never
 * read. The distribution tests counted refs; this one asks the agent's hook.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendRecord, listRecords } from "../protocol/record";
import { cli, git, rec, runHook, tmp } from "./helpers";


const abandoned = (goal: string, why: string, run: string) => rec({
  session: { agent: "claude-code", run_id: run },
  intent: { goal }, outcome: { status: "abandoned", errors: [why], recheck: "bun test" },
});

/** What the hook hands the agent when this prompt is submitted in `repo`. */
function briefing(repo: string, state: string, prompt: string): string | null {
  const out = runHook("inject", "UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "mine", cwd: repo, prompt },
    { ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") });
  return out ? out.hookSpecificOutput.additionalContext : null;
}

async function team() {
  const dir = tmp("anvc-team-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const clone = (name: string) => {
    const path = join(dir, name);
    Bun.spawnSync(["git", "clone", "-q", origin, path], { stdout: "pipe", stderr: "pipe" });
    git(path, "config", "user.email", `${name}@example.com`);
    git(path, "config", "user.name", name);
    return path;
  };
  const partner = clone("partner");
  git(partner, "commit", "-q", "--allow-empty", "-m", "base");
  git(partner, "branch", "-M", "main");
  git(partner, "push", "-q", "-u", "origin", "main");
  return { dir, partner, me: clone("me"), state: join(dir, "state") };
}

test("a dead end a teammate pushed reaches my agent after a fetch", async () => {
  const { dir, partner, me, state } = await team();
  expect(cli(partner, "init").code).toBe(0);
  appendRecord(partner, abandoned(
    "Cache the ref index in memory",
    "goes stale after any write, and nothing invalidates it",
    "partner-session",
  ));
  git(partner, "push", "-q", "origin");

  expect(cli(me, "init").code).toBe(0);
  git(me, "fetch", "-q", "origin");

  const context = briefing(me, state, "should we cache the ref index in memory?");
  expect(context, "the teammate's record was fetched and never read").toContain("Cache the ref index in memory");
  expect(context).toContain("goes stale after any write");
}, 60_000);

test("my own record, pushed and fetched back, is read once", async () => {
  const { dir, me } = await team();
  expect(cli(me, "init").code).toBe(0);
  git(me, "fetch", "-q", "origin");
  git(me, "checkout", "-q", "main");
  appendRecord(me, abandoned("Shard refs by date", "hot shard on every write", "my-session"));
  git(me, "push", "-q", "origin");
  git(me, "fetch", "-q", "origin");

  // The same blob now sits under refs/anvc/ and refs/remotes/origin/anvc/.
  // Counted twice, every query would show it twice.
  expect(git(me, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/anvc/")).not.toBe("");
  expect(listRecords(me).map((r) => r.ref)).toEqual([expect.stringMatching(/^refs\/anvc\//)]);
}, 60_000);
