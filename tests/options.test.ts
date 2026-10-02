/**
 * `anvc options`: every setting, with a command that sets each choice. An
 * agent runs those commands for the person, so each one has to exist, and
 * letting the agent do it must not send anything anywhere before it asks.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupEverywhere, type Options, type Setting } from "../protocol/options";
import { git, gitRepo, tmp } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");

/** A project with a remote and an AGENTS.md, and a HOME of its own so nothing reaches the real config. */
function fixture() {
  const repo = gitRepo({ commit: true });
  git(repo, "remote", "add", "origin", "git@github.com:x/y.git");
  writeFileSync(join(repo, "AGENTS.md"), "# Instructions\n");
  const home = tmp("anvc-options-home-");
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), ANVC_STATE_HOME: join(home, ".anvc") };
  // Run from outside the project, so every command has to name it.
  const sh = (command: string) => Bun.spawnSync(["sh", "-c", command], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  const read = (): Options => {
    const p = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), "options", "--json", "--repo", repo], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
  };
  return { repo, home, env, sh, read };
}

const everySetting = (list: Setting[]): Setting[] => list.flatMap((s) => [s, ...everySetting(s.parts ?? [])]);

test("anvc options lists every setting with its choices, the recommended one and a command that sets it", () => {
  const { read } = fixture();
  const o = read();
  expect(o.about).toContain("ask the person before changing it");
  expect(o.settings.map((s) => s.key)).toEqual(["agents", "where", "folder", "assist", "results", "absorb", "sharing", "local", "push", "prepush", "instructions", "approvegoals"]);
  // Whatever can send records off this computer or change a committed file is marked.
  expect(o.settings.filter((s) => s.asks).map((s) => s.key)).toEqual(["absorb", "sharing", "local", "push", "prepush", "instructions"]);
  for (const s of everySetting(o.settings)) {
    expect(s.name && s.what, s.key).toBeTruthy();
    expect(s.choices.length, s.key).toBeGreaterThanOrEqual(2);
    const values = s.choices.map((c) => c.value);
    for (const r of [s.recommended].flat()) expect(values, s.key).toContain(r);
    expect(s.choices.some((c) => c.set), s.key).toBe(true);
  }
});

// Skipped on Windows: these run the printed commands through sh.
const posix = test.skipIf(process.platform === "win32");

posix("every command anvc options gives runs", () => {
  const { sh, read } = fixture();
  const commands = [...new Set(everySetting(read().settings)
    .flatMap((s) => s.choices.flatMap((c) => [c.set, c.setEverywhere]))
    .filter((c): c is string => Boolean(c)))];
  expect(commands.length).toBeGreaterThan(20);
  const failed = commands.flatMap((command) => {
    const p = sh(command);
    const out = `${p.stdout}${p.stderr}`;
    return p.exitCode === 0 && !/usage:|anvc — checkpoint records/.test(out) ? [] : [`${command}\n${out}`];
  });
  expect(failed).toEqual([]);
  // Each switch's off runs after its on.
  const now = Object.fromEntries(read().settings.map((s) => [s.key, s.here]));
  expect(now).toMatchObject({ where: "everywhere", push: "off", prepush: "off", instructions: "off" });
}, 120_000);

posix("git push, the push check and the AGENTS.md lines turn off again, leaving things as they were", () => {
  const { repo, env, sh, read } = fixture();
  const hooks = join(repo, ".git/hooks");
  mkdirSync(hooks, { recursive: true });
  // A pre-push hook of the person's own, which the check wraps and gives back.
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
  const config = () => git(repo, "config", "--get-regexp", "^remote\\.origin\\.");
  const before = { config: config(), hook: readFileSync(join(hooks, "pre-push"), "utf8"), agents: readFileSync(join(repo, "AGENTS.md"), "utf8") };

  const text = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), "options", "--repo", repo], { cwd: repo, env, stdout: "pipe" }).stdout.toString();
  expect(text).toContain("Off: bun");
  expect(text).toContain("init --off");
  expect(text).toMatch(/Change: bun \S+ push-check <on\|off>/);
  expect(text).toMatch(/Change: bun \S+ instructions <on\|off>/);

  const setting = (key: string) => read().settings.find((s) => s.key === key)!;
  const run = (key: string, value: string) => {
    const command = setting(key).choices.find((c) => c.value === value)!.set!;
    expect(sh(command).exitCode, command).toBe(0);
    return setting(key);
  };
  for (const key of ["push", "prepush", "instructions"]) {
    expect(run(key, "on"), key).toMatchObject({ here: "on", chosen: true });
    expect(run(key, "off"), key).toMatchObject({ here: "off", chosen: false });
  }
  expect(config()).toBe(before.config);
  expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(before.hook);
  expect(existsSync(join(hooks, "pre-push.before-anvc"))).toBe(false);
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before.agents);
}, 60_000);

posix("chosen tells a default from a choice", () => {
  const { sh, read } = fixture();
  const chosen = () => everySetting(read().settings).filter((s) => s.chosen).map((s) => s.key).sort();
  // A new repository: every value is the default, so nothing reads as chosen.
  expect(chosen()).toEqual([]);
  const set = (key: string, value: string) => sh(read().settings.find((s) => s.key === key)!.choices.find((c) => c.value === value)!.set!);
  set("assist", "start");
  set("sharing", "private-repo");
  const moments = read().settings.find((s) => s.key === "assist")!.parts!.map((p) => p.key);
  expect(chosen()).toEqual(["assist", ...moments, "sharing", "tier"].sort());
}, 60_000);

posix("with local only on, sharing and new records say local only overrides them", () => {
  const { repo, env, sh, read } = fixture();
  const sharing = () => read().settings.find((s) => s.key === "sharing")!;
  expect(sharing().overriddenBy).toBeUndefined();
  sh(read().settings.find((s) => s.key === "local")!.choices.find((c) => c.value === "on")!.set!);
  expect(sharing().overriddenBy).toBe("local");
  expect(sharing().parts![0]).toMatchObject({ key: "tier", overriddenBy: "local" });
  const text = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), "options", "--repo", repo], { cwd: repo, env, stdout: "pipe" }).stdout.toString();
  expect(text).toContain("Sharing: Team (Local only overrides this)");
  expect(text).toContain("New records: Shared (Local only overrides this)");
}, 60_000);

posix("letting the agent do it installs hooks and changes nothing that asks first", () => {
  const { repo, sh, read } = fixture();
  const asked = (o: Options) => Object.fromEntries(o.settings.filter((s) => s.asks).map((s) => [s.key, s.here]));
  const before = read();
  const setup = sh(["bun", join(ROOT, "scripts/setup.ts"), ...setupEverywhere(["claude-code", "codex", "cursor"])].join(" "));
  expect(setup.exitCode).toBe(0);
  const after = read();
  expect(after.settings.find((s) => s.key === "where")!.here).toBe("everywhere");
  expect(asked(after)).toEqual(asked(before));
  expect(asked(after)).toMatchObject({ push: "off", prepush: "off", instructions: "off" });
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# Instructions\n");
}, 60_000);
