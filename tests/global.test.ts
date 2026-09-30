/**
 * Installed once for an agent, ANVC runs in every repository, and repositories
 * set up one at a time before lose their own copy of the hooks so nothing
 * runs twice.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitRepo, tmp } from "./helpers";

const SETUP = resolve(import.meta.dir, "../scripts/setup.ts");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const ourHooks = (file: string) => (JSON.stringify(json(file)).match(/emitters\/claude-code/g) ?? []).length;

test("setup --global installs for every repository and takes out per-repository copies", async () => {
  const home = tmp("anvc-global-home-");
  const repo = gitRepo();
  // Everything that could reach the person's real config points here.
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), ANVC_STATE_HOME: join(home, ".anvc") };
  const setup = (...args: string[]) => Bun.spawnSync(["bun", SETUP, ...args], { env, stdout: "pipe", stderr: "pipe" });

  // The old way first: this repository has its own Codex and Cursor hooks.
  expect(setup("--repo", repo, "--agent", "codex,cursor", "--no-instructions").exitCode).toBe(0);
  expect(ourHooks(join(repo, ".codex", "hooks.json"))).toBeGreaterThan(0);
  expect(json(join(repo, ".cursor", "mcp.json")).mcpServers.anvc).toBeTruthy();

  const run = setup("--global", "--agent", "claude-code,codex,cursor");
  expect(run.exitCode).toBe(0);
  expect(json(join(home, ".claude", "settings.json")).enabledPlugins["anvc@anvc"]).toBe(true);
  const codex = ourHooks(join(home, ".codex", "hooks.json"));
  expect(codex).toBeGreaterThan(0);
  expect(ourHooks(join(home, ".cursor", "hooks.json"))).toBeGreaterThan(0);
  expect(json(join(home, ".cursor", "mcp.json")).mcpServers.anvc.env.ANVC_REPO).toBe("${workspaceFolder}");

  // The repository's own copies are gone, so each event runs once.
  expect(ourHooks(join(repo, ".codex", "hooks.json"))).toBe(0);
  expect(ourHooks(join(repo, ".cursor", "hooks.json"))).toBe(0);
  expect(json(join(repo, ".cursor", "mcp.json")).mcpServers.anvc).toBeUndefined();
  const installs = json(join(home, ".anvc", "installs.json")) as Array<{ repo: string; agent: string }>;
  expect(installs.map((i) => `${i.repo} ${i.agent}`).sort()).toEqual(["* claude-code", "* codex", "* cursor"]);

  // Again, and then per repository: nothing is added twice.
  setup("--global", "--agent", "codex");
  expect(ourHooks(join(home, ".codex", "hooks.json"))).toBe(codex);
  const again = setup("--repo", repo, "--agent", "codex", "--no-instructions");
  expect(again.stdout.toString()).toContain("in every repository, so no hooks are added here");
  expect(ourHooks(join(repo, ".codex", "hooks.json"))).toBe(0);
}, 60_000);

test("a dry run for every repository lists the files setup then writes, and writes none", () => {
  const home = tmp("anvc-global-dry-");
  const repo = gitRepo();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), ANVC_STATE_HOME: join(home, ".anvc") };
  const setup = (...args: string[]) => Bun.spawnSync(["bun", SETUP, ...args], { env, stdout: "pipe", stderr: "pipe" });
  // Each agent's own folder, and the repository's files. Bun keeps a cache under HOME too.
  const files = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /^\.(claude|codex|cursor)[\\/]/.test(f) && statSync(join(dir, f)).isFile()).map((f) => join(dir, f));
  // A repository set up on its own first, whose hooks the install for every repository takes out.
  expect(setup("--repo", repo, "--agent", "codex", "--no-instructions", "--no-remote").exitCode).toBe(0);
  const before = [...files(home), ...files(repo)].map((f) => `${f} ${readFileSync(f, "utf8")}`);

  const dry = setup("--global", "--agent", "claude-code,codex,cursor", "--dry-run");
  expect(dry.exitCode).toBe(0);
  expect([...files(home), ...files(repo)].map((f) => `${f} ${readFileSync(f, "utf8")}`)).toEqual(before);
  const listed = dry.stdout.toString().split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, l.indexOf(": "))).sort();

  expect(setup("--global", "--agent", "claude-code,codex,cursor").exitCode).toBe(0);
  const changed = [...files(home), ...files(repo)].filter((f) => !before.includes(`${f} ${readFileSync(f, "utf8")}`)).sort();
  expect(listed).toEqual(changed);
  expect(listed).toContain(join(repo, ".codex", "hooks.json"));
}, 60_000);
