/**
 * `anvc uninstall` undoes what setup did in a project, leaves what's the
 * person's, and keeps records and AGENTS.md lines unless asked.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { folderOn, noteFolder } from "../protocol/folders";
import { appendRecord, type CheckpointRecord } from "../protocol/record";
import { withoutCodexServer } from "../protocol/uninstall";
import { cli, git, gitRepo, rec, setEnv, tmp } from "./helpers";

const SETUP = resolve(import.meta.dir, "../scripts/setup.ts");
const setup = (repo: string, ...args: string[]) =>
  Bun.spawnSync(["bun", SETUP, "--repo", repo, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode;

test("uninstall takes out what setup added, and keeps the person's own", () => {
  const repo = gitRepo({ commit: true });
  git(repo, "remote", "add", "origin", "git@github.com:x/y.git");
  writeFileSync(join(repo, "AGENTS.md"), "# Notes\n\nKeep tests green.\n");
  for (const agent of ["claude-code", "codex", "cursor"]) expect(setup(repo, "--agent", agent)).toBe(0);
  expect(setup(repo, "--pre-push", "--instructions")).toBe(0);
  // A hook of the person's own, beside ANVC's.
  const local = join(repo, ".claude/settings.local.json");
  const mine = JSON.parse(readFileSync(local, "utf8"));
  mine.hooks.Stop.push({ hooks: [{ type: "command", command: "echo mine" }] });
  writeFileSync(local, JSON.stringify(mine));
  appendRecord(repo, rec({ intent: { goal: "Try the cache" } }) as CheckpointRecord);

  const { code, out } = cli(repo, "uninstall");
  expect(code).toBe(0);
  const config = git(repo, "config", "--get-regexp", "^remote\\.origin\\.");
  expect(config).not.toContain("anvc");
  expect(config).not.toMatch(/push HEAD/);
  for (const rel of [".codex/hooks.json", ".cursor/hooks.json", ".cursor/mcp.json"]) expect(existsSync(join(repo, rel)), rel).toBe(false);
  // The person's hook stays; ANVC's are gone.
  expect(readFileSync(local, "utf8")).toContain("echo mine");
  expect(readFileSync(local, "utf8")).not.toContain("emitters/claude-code");
  const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8");
  expect(exclude).not.toContain(".cursor/mcp.json");
  expect(existsSync(join(repo, ".git/hooks/pre-push"))).toBe(false);
  expect(folderOn(repo)).toBe(false);
  // Kept until asked: the record and the AGENTS.md lines.
  expect(out).toContain("kept: 1 record in this clone");
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("anvc_checkpoint");

  expect(cli(repo, "uninstall", "--records", "--instructions").code).toBe(0);
  expect(git(repo, "for-each-ref", "refs/anvc/", "refs/anvc-private/").trim()).toBe("");
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# Notes\n\nKeep tests green.\n");
}, 60_000);

test("an empty hook file an earlier removal left behind goes, but only one setup wrote", () => {
  const repo = gitRepo({ commit: true });
  writeFileSync(join(repo, ".git/info/exclude"), ".cursor/hooks.json\n");
  for (const dir of [".cursor", ".codex"]) mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, ".cursor/hooks.json"), JSON.stringify({ version: 1 }));
  // Not in info/exclude: the person's, even though it's empty.
  writeFileSync(join(repo, ".codex/hooks.json"), JSON.stringify({ version: 1 }));
  expect(cli(repo, "uninstall").code).toBe(0);
  expect(existsSync(join(repo, ".cursor"))).toBe(false);
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).not.toContain(".cursor/hooks.json");
  expect(existsSync(join(repo, ".codex/hooks.json"))).toBe(true);
}, 60_000);

test("uninstall --everywhere takes ANVC out of each agent's own config and keeps everything else", () => {
  const home = tmp("anvc-uninstall-home-");
  setEnv({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), ANVC_STATE_HOME: join(home, ".anvc") });
  const repo = gitRepo({ commit: true });
  expect(Bun.spawnSync(["bun", SETUP, "--global", "--agent", "claude-code,codex,cursor"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  const json = (file: string) => JSON.parse(readFileSync(join(home, file), "utf8"));
  const write = (file: string, data: unknown) => writeFileSync(join(home, file), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  const theirs = { hooks: [{ type: "command", command: "notify-send done" }] };

  // The person's own entries beside ANVC's, in every file it touched.
  const claude = json(".claude/settings.json");
  claude.enabledPlugins["tidy@market"] = true;
  claude.hooks = { Stop: [theirs, { hooks: [{ type: "command", command: `bun "/old/anvc"/emitters/claude-code/stop.ts Stop` }] }] };
  write(".claude/settings.json", claude);
  write(".claude/.claude.json", { mcpServers: { anvc: { command: "bun", args: ["/old/anvc/protocol/mcp.ts"] }, github: { command: "gh-mcp" } }, projects: { [repo]: { mcpServers: { anvc: { command: "bun" } } } } });
  const codex = json(".codex/hooks.json");
  codex.hooks.Stop.push(theirs);
  write(".codex/hooks.json", codex);
  write(".codex/config.toml", `model = "o3"\n\n[mcp_servers.anvc]\ncommand = "bun"\nargs = ["/old/anvc/protocol/mcp.ts"]\n\n[mcp_servers.anvc.env]\nANVC_AGENT = "codex"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n`);
  const cursor = json(".cursor/hooks.json");
  cursor.hooks.stop.push({ command: "notify-send done" });
  write(".cursor/hooks.json", cursor);
  const cursorMcp = json(".cursor/mcp.json");
  cursorMcp.mcpServers.github = { command: "gh-mcp" };
  write(".cursor/mcp.json", cursorMcp);
  // A folder ANVC has run in, with a record.
  noteFolder(repo);
  appendRecord(repo, rec() as CheckpointRecord);

  const files = [".claude/settings.json", ".claude/.claude.json", ".codex/hooks.json", ".codex/config.toml", ".cursor/hooks.json", ".cursor/mcp.json"];
  const read = () => files.map((f) => readFileSync(join(home, f), "utf8"));
  const before = read();
  const dry = cli(repo, "uninstall", "--everywhere", "--dry-run");
  expect(dry.code).toBe(0);
  expect(read()).toEqual(before);
  // On Windows the paths are written with \.
  for (const f of files) expect(dry.out.replaceAll("\\", "/")).toContain(`~/${f}`);

  const { code, out } = cli(repo, "uninstall", "--everywhere");
  expect(code).toBe(0);
  expect(out).toContain("kept: 1 record in 1 project");
  const settings = json(".claude/settings.json");
  expect(settings.enabledPlugins).toEqual({ "tidy@market": true });
  expect(settings.extraKnownMarketplaces).toBeUndefined();
  expect(settings.hooks).toEqual({ Stop: [theirs] });
  const config = json(".claude/.claude.json");
  expect(config.mcpServers).toEqual({ github: { command: "gh-mcp" } });
  // One project's own registration is that project's.
  expect(config.projects[repo].mcpServers.anvc).toBeTruthy();
  expect(json(".codex/hooks.json").hooks).toEqual({ Stop: [theirs] });
  expect(Bun.TOML.parse(readFileSync(join(home, ".codex/config.toml"), "utf8"))).toEqual({ model: "o3", mcp_servers: { docs: { command: "docs-mcp" } } });
  expect(json(".cursor/hooks.json").hooks).toEqual({ stop: [{ command: "notify-send done" }] });
  expect(json(".cursor/mcp.json").mcpServers).toEqual({ github: { command: "gh-mcp" } });
  expect(JSON.parse(readFileSync(join(home, ".anvc/installs.json"), "utf8"))).toEqual([]);
  expect(git(repo, "for-each-ref", "refs/anvc/", "refs/anvc-private/")).not.toBe("");

  // Nothing is left to take out, and asked to, it deletes the records too.
  expect(cli(repo, "uninstall", "--everywhere").out).toContain("isn't installed for every project");
  expect(cli(repo, "uninstall", "--everywhere", "--records").code).toBe(0);
  expect(git(repo, "for-each-ref", "refs/anvc/", "refs/anvc-private/")).toBe("");
}, 60_000);

test("Codex's MCP server comes out of config.toml only when nothing else would change", () => {
  const toml = `[mcp_servers.anvc]\ncommand = "bun"\n\n[mcp_servers.anvc.env]\nANVC_AGENT = "codex"\n`;
  expect(withoutCodexServer(toml)).toBe("");
  expect(withoutCodexServer(`model = "o3"\n`)).toBeUndefined();
  // Written inline, the table has no header of its own to cut at.
  expect(withoutCodexServer(`mcp_servers.anvc = { command = "bun" }\nmodel = "o3"\n`)).toBeNull();
});
