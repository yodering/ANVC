/**
 * A stranger has to get from a clone to a working install.
 *
 * Everything `setup` does was previously done by hand, which is why the tool
 * only worked on the machine it was written on: the MCP server had to be wired
 * from nothing, the hooks pasted in, and the git refspecs configured or records
 * silently never left the repository. That last one is most of why git notes
 * never caught on.
 *
 * It edits a user's settings file, so the tests here are mostly about what it
 * must not damage.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { codexHooks, cursorHooks, mergeHooks, quoted, removeOurs } from "../scripts/hookfiles";
import { git, gitRepo, tmp } from "./helpers";

const SETUP = resolve(import.meta.dir, "../scripts/setup.ts");

function run(repo: string, agent: string | null = "claude-code") {
  const args = ["bun", SETUP, "--repo", repo, ...(agent ? ["--agent", agent] : [])];
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return { out: proc.stdout.toString() + proc.stderr.toString(), code: proc.exitCode };
}

async function repoAt(): Promise<string> {
  const repo = gitRepo();
  git(repo, "remote", "add", "origin", "git@github.com:x/y.git");
  return repo;
}

// Any repository but ANVC's own gets its hooks in the uncommitted file, since
// they name the path ANVC was cloned to on this machine.
const LOCAL = ".claude/settings.local.json";
const settings = async (repo: string, file = LOCAL) =>
  JSON.parse(await readFile(join(repo, file), "utf8"));

test("one command takes a fresh repository to a working install", async () => {
  const repo = await repoAt();
  const { out, code } = run(repo);
  expect(code).toBe(0);

  // Records travel. Without these a plain push leaves them behind and a
  // teammate's clone fetches none of them.
  const push = Bun.spawnSync(["git", "-C", repo, "config", "--get-all", "remote.origin.push"])
    .stdout.toString();
  expect(push).toContain("refs/anvc/*:refs/anvc/*");
  // Restated deliberately: adding any push refspec replaces git's default,
  // so omitting this would silently stop pushing branches. `HEAD` and not
  // `refs/heads/*`, which pushed every local branch on a plain `git push`.
  expect(push.split("\n")).toContain("HEAD");
  expect(push).not.toContain("refs/heads/*");

  // The hooks name this machine's clone of ANVC, so they must not be
  // committed with the project, where a teammate's would point at nothing.
  expect(existsSync(join(repo, ".claude/settings.json"))).toBe(false);
  const ignored = Bun.spawnSync(["git", "-C", repo, "check-ignore", "-q", LOCAL]);
  expect(ignored.exitCode, "settings.local.json would be committed").toBe(0);

  // Capture writes events; inject reads records back to the agent.
  const hooks = (await settings(repo)).hooks;
  expect(Object.keys(hooks).sort()).toEqual(
    ["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);

  // Every documented way a session can begin. Missing one is invisible: the
  // hook simply never runs for that case, and nothing reports it. We shipped
  // without `compact` — the single most valuable moment to brief an agent —
  // and then without `fork`, both for exactly that reason.
  const start = JSON.stringify(hooks.SessionStart);
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    expect(start, `SessionStart does not fire on ${source}`).toContain(source);
  }

  // Capture and inject both run on UserPromptSubmit, and both commands end
  // in that word. Matching an existing hook on the event name alone made the
  // second install overwrite the first, which turned capture off on the one
  // event that starts every turn — and left no trace that it had.
  const prompt = JSON.stringify(hooks.UserPromptSubmit);
  expect(prompt, "capture is not wired to UserPromptSubmit").toContain("capture.ts UserPromptSubmit");
  expect(prompt, "inject is not wired to UserPromptSubmit").toContain("inject.ts UserPromptSubmit");
  // The same collision on Stop would turn off either capture or the request
  // for a checkpoint.
  const stop = JSON.stringify(hooks.Stop);
  expect(stop, "capture is not wired to Stop").toContain("capture.ts Stop");
  expect(stop, "the checkpoint request is not wired to Stop").toContain("stop.ts Stop");

  // Injection only counts on an event confirmed to deliver context to a live
  // agent. PreToolUse emits correct JSON that Claude Code discards, so a
  // green test suite said nothing about whether the agent heard any of it.
  // Adding an event here means someone verified it by asking a real agent.
  // PostToolUse and PostToolUseFailure: a probe hook's code word came back
  // from a headless Claude Code 2.1.283 session on 2026-09-27.
  const delivers = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse", "PostToolUseFailure"]);
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!JSON.stringify(entries).includes("inject.ts")) continue;
    if (event === "PreToolUse") continue;  // known not to deliver; kept as a no-op
    expect(delivers.has(event), `inject is wired to ${event}, which is not verified to reach the model`).toBe(true);
  }

  // The MCP config is printed rather than written, because every agent keeps
  // it somewhere different and guessing would edit a file nobody asked us to.
  expect(out).toContain("claude mcp add-json anvc");
  expect(out).toContain("anvc_checkpoint");
}, 60_000);

test("running it twice changes nothing", async () => {
  const repo = await repoAt();
  run(repo);
  const first = await readFile(join(repo, LOCAL), "utf8");
  const exclude = await readFile(join(repo, ".git/info/exclude"), "utf8");

  const { out } = run(repo);
  expect(out).toContain("already configured");
  expect(out).toContain("already installed");
  expect(await readFile(join(repo, LOCAL), "utf8")).toBe(first);
  expect(await readFile(join(repo, ".git/info/exclude"), "utf8")).toBe(exclude);
}, 60_000);

test("someone else's hooks survive", async () => {
  const repo = await repoAt();
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(join(repo, ".claude/settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] }],
    },
    somethingElse: { keep: true },
  }));

  run(repo);
  const theirs = await settings(repo, ".claude/settings.json");
  const ours = await settings(repo);

  // Adding our hooks must not remove theirs, and must not drop unrelated
  // settings we do not understand.
  expect(commands(theirs).some((c) => c.includes("echo theirs"))).toBe(true);
  expect(theirs.somethingElse).toEqual({ keep: true });
  // Fourteen: capture on PostToolUse, PostToolUseFailure, UserPromptSubmit,
  // Stop, SessionEnd, SubagentStart and SubagentStop; inject on
  // PostToolUseFailure, UserPromptSubmit, PreToolUse, SessionStart and
  // SubagentStart; the checkpoint request on Stop; the final session copy on
  // SessionEnd.
  expect(commands(ours).filter((c) => c.includes("emitters/claude-code")).length).toBe(14);
}, 60_000);

test("hooks an earlier setup committed are moved out, and theirs stay", async () => {
  const repo = await repoAt();
  // What the first version of setup wrote: our hooks in the committed file,
  // naming one machine's path, beside a hook of the project's own.
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(join(repo, ".claude/settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] },
        { matcher: "Read", hooks: [{ type: "command", command: "bun /Users/someone/anvc/emitters/claude-code/capture.ts PostToolUse" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "bun /Users/someone/anvc/emitters/claude-code/capture.ts Stop" }] }],
    },
  }));

  const { out } = run(repo);
  expect(out).toContain("moved 2 ANVC hooks");
  const shared = commands(await settings(repo, ".claude/settings.json"));
  // Left in place, every hook would fire twice.
  expect(shared).toEqual(["echo theirs"]);
  expect(commands(await settings(repo)).filter((c) => c.includes("emitters/claude-code")).length).toBe(14);
}, 60_000);

const commands = (s: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }) =>
  Object.values(s.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));

test("a corrupt settings file is refused, not overwritten", async () => {
  const repo = await repoAt();
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(join(repo, ".claude/settings.json"), "{ not json");

  const { out } = run(repo);
  expect(out).toContain("not valid JSON");
  // Their file is theirs to fix; overwriting it would take whatever else is
  // in there with it.
  expect(await readFile(join(repo, ".claude/settings.json"), "utf8")).toBe("{ not json");
  // And refused before anything else was written.
  expect(existsSync(join(repo, LOCAL))).toBe(false);
}, 60_000);

test("it refuses a directory that is not a repository", async () => {
  const dir = tmp("anvc-not-a-repo-");
  const { out, code } = run(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("not a git repository");
}, 30_000);

test("it asks which agent, and changes nothing until told", async () => {
  const repo = await repoAt();
  const { out, code } = run(repo, null);
  expect(code).toBe(2);
  expect(out).toContain("--agent");
  expect(out).toContain("Nothing was changed");
  const push = Bun.spawnSync(["git", "-C", repo, "config", "--get-all", "remote.origin.push"]).stdout.toString();
  expect(push).toBe("");
  expect(existsSync(join(repo, ".claude"))).toBe(false);
}, 30_000);

test("another agent gets git and MCP, and no Claude Code hooks", async () => {
  for (const agent of ["codex", "cursor", "opencode"]) {
    const repo = await repoAt();
    const { out, code } = run(repo, agent);
    expect(code).toBe(0);
    const push = Bun.spawnSync(["git", "-C", repo, "config", "--get-all", "remote.origin.push"]).stdout.toString();
    expect(push).toContain("refs/anvc/*:refs/anvc/*");
    expect(existsSync(join(repo, ".claude")), `${agent} got a .claude directory`).toBe(false);
    expect(out).toContain("anvc_dead_ends");
    if (agent === "codex") {
      expect(out).toContain("codex mcp add anvc --env ANVC_AGENT=codex");
      // Codex's MCP config is global, so it must not pin one repository.
      expect(out).not.toContain("ANVC_REPO");
    } else if (agent === "cursor") {
      // Written rather than printed: Cursor's MCP file sits beside its hooks.
      expect(out).toContain(".cursor/mcp.json");
      expect(readFileSync(join(repo, ".cursor", "mcp.json"), "utf8")).toContain(`"ANVC_AGENT": "cursor"`);
    } else {
      expect(out).toContain(`"ANVC_AGENT": "${agent}"`);
    }
  }
}, 60_000);

test("setup adds the recording line to AGENTS.md once, and creates no file", async () => {
  const withFile = await repoAt();
  const without = await repoAt();
  await Bun.write(join(withFile, "AGENTS.md"), "# Rules\n\nUse Bun.\n");
  run(withFile, "claude-code");
  run(withFile, "claude-code");
  const body = await Bun.file(join(withFile, "AGENTS.md")).text();
  // The agent reads this file; a line it is never shown is a line it never follows.
  expect(body.match(/anvc_checkpoint/g)).toHaveLength(1);
  expect(body.startsWith("# Rules\n\nUse Bun.")).toBe(true);

  run(without, "claude-code");
  expect(await Bun.file(join(without, "AGENTS.md")).exists()).toBe(false);
  expect(await Bun.file(join(without, "CLAUDE.md")).exists()).toBe(false);
});

test("a hook written with a quoted path is recognised, not added a second time", async () => {
  const repo = await repoAt();
  // ANVC's own checkout writes "$CLAUDE_PROJECT_DIR" in quotes, which JSON
  // escapes; matching on the serialised hook missed it and doubled every hook.
  await Bun.write(join(repo, LOCAL), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command",
    command: `bun "$CLAUDE_PROJECT_DIR"/emitters/claude-code/inject.ts SessionStart` }] }] } }));
  run(repo);
  const starts = (await settings(repo)).hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
  expect(starts.flatMap((h) => h.hooks).filter((c) => c.command.includes("inject.ts"))).toHaveLength(1);
});

test("a config file the project commits gets no machine's path; setup prints what to add", async () => {
  for (const [agent, files] of [
    ["cursor", [".cursor/mcp.json", ".cursor/hooks.json"]],
    ["codex", [".codex/hooks.json"]],
    ["claude-code", [LOCAL]],
  ] as const) {
    const repo = await repoAt();
    for (const file of files) {
      await mkdir(join(repo, file, ".."), { recursive: true });
      await writeFile(join(repo, file), "{}\n");
    }
    git(repo, "add", "-f", ...files);
    git(repo, "commit", "-q", "-m", "shared editor settings");
    const { out, code } = run(repo, agent);
    expect(code).toBe(0);
    for (const file of files) {
      expect(readFileSync(join(repo, file), "utf8")).toBe("{}\n");
      expect(out).toContain(`${file} is committed in this project`);
      expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain(file);
    }
    // ANVC's folder is quoted in hook commands, so look for it and the script
    // apart. A Windows path's backslashes come escaped for sh, then for JSON.
    expect(out.replace(/\\\\/g, "\\").replace(/\\\\/g, "\\")).toContain(resolve(import.meta.dir, ".."));
    expect(out).toContain("/emitters/claude-code/inject.ts");
  }
}, 60_000);

test("several agents are set up in one go, each as if named alone", async () => {
  const repo = await repoAt();
  const { code } = run(repo, "claude-code,codex,cursor");
  expect(code).toBe(0);
  expect(await Bun.file(join(repo, LOCAL)).exists()).toBe(true);
  expect(await Bun.file(join(repo, ".codex/hooks.json")).exists()).toBe(true);
  expect(await Bun.file(join(repo, ".cursor/hooks.json")).exists()).toBe(true);
}, 60_000);

test("--plugin names the anvc plugin in the committed settings and removes hooks written the old way", async () => {
  const repo = await repoAt();
  run(repo);
  expect(JSON.stringify(await settings(repo))).toContain("emitters/claude-code");
  const p = Bun.spawnSync(["bun", SETUP, "--repo", repo, "--agent", "claude-code", "--plugin"], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const shared = await settings(repo, ".claude/settings.json");
  expect(shared.enabledPlugins["anvc@anvc"]).toBe(true);
  expect(shared.extraKnownMarketplaces.anvc.source).toEqual({ source: "github", repo: "yodering/anvc" });
  expect(JSON.stringify(await settings(repo))).not.toContain("emitters/claude-code");
  expect(p.stdout.toString()).toContain("nothing to register");
});

// Skipped on Windows: the hook runs through sh, and a Windows file name can't hold a quote.
test.skipIf(process.platform === "win32")("a hook names ANVC's folder in quotes, so a shell runs the script and nothing in the name", () => {
  const dir = tmp("anvc-quoted-");
  const here = join(dir, 'my anvc "$(touch ran)"');
  mkdirSync(join(here, "emitters/claude-code"), { recursive: true });
  writeFileSync(join(here, "emitters/claude-code/inject.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));`);
  for (const command of [codexHooks(here).SessionStart![0]!.command, cursorHooks(here).sessionStart![0]!]) {
    rmSync(join(dir, "args.json"), { force: true });
    expect(Bun.spawnSync(["sh", "-c", command], { cwd: dir }).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "args.json"), "utf8"))[0]).toBe("SessionStart");
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }
});

test("hooks an earlier setup wrote without quotes are replaced, not doubled", async () => {
  const repo = await repoAt();
  const here = resolve(import.meta.dir, "..");
  const old = (script: string, event: string, agent = "") => `bun ${here}/emitters/claude-code/${script}.ts ${event}${agent}`;
  await mkdir(join(repo, ".claude"), { recursive: true });
  await mkdir(join(repo, ".codex"), { recursive: true });
  await mkdir(join(repo, ".cursor"), { recursive: true });
  await writeFile(join(repo, LOCAL), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: old("inject", "SessionStart") }] }] } }));
  await writeFile(join(repo, ".codex/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: old("inject", "SessionStart", " --agent codex") }] }] } }));
  await writeFile(join(repo, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: old("inject", "SessionStart", " --agent cursor") }] } }));
  expect(run(repo, "claude-code,codex,cursor").code).toBe(0);
  const commands = [
    ...(await settings(repo)).hooks.SessionStart.flatMap((h: { hooks: Array<{ command: string }> }) => h.hooks.map((c) => c.command)),
    ...(await settings(repo, ".codex/hooks.json")).hooks.SessionStart.flatMap((h: { hooks: Array<{ command: string }> }) => h.hooks.map((c) => c.command)),
    ...(await settings(repo, ".cursor/hooks.json")).hooks.sessionStart.map((h: { command: string }) => h.command),
  ];
  expect(commands).toHaveLength(3);
  for (const command of commands) expect(command).toStartWith(`bun ${quoted(here)}/emitters/claude-code/inject.ts SessionStart`);
}, 60_000);

test("a person's command in the same entry as ours stays when ours is replaced or removed", () => {
  const here = "/opt/anvc";
  const ours = (event: string, path = here) => `bun ${quoted(path)}/emitters/claude-code/inject.ts ${event}`;
  const theirs = { type: "command", command: "echo theirs" };
  const entry = (matcher: string, command: string) => ({ matcher, hooks: [{ type: "command", command }, theirs] });
  const settings = { hooks: { SessionStart: [entry("startup", ours("SessionStart", "/old/anvc"))], PreToolUse: [entry("Read", ours("PreToolUse"))] } };
  const wanted = { SessionStart: [{ matcher: "startup", command: ours("SessionStart") }], PreToolUse: [{ matcher: "Read|Edit", command: ours("PreToolUse") }] };

  expect(mergeHooks(settings, wanted)).toBe(2);
  // Same matcher: our command is updated where it is.
  expect(settings.hooks.SessionStart).toEqual([entry("startup", ours("SessionStart"))]);
  // A new one would apply to theirs as well, so ours gets its own entry.
  expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Read", hooks: [theirs] }, { matcher: "Read|Edit", hooks: [{ type: "command", command: ours("PreToolUse") }] }]);
  expect(mergeHooks(settings, wanted)).toBe(0);

  expect(removeOurs(settings)).toBe(2);
  expect(settings.hooks).toEqual({ SessionStart: [{ matcher: "startup", hooks: [theirs] }], PreToolUse: [{ matcher: "Read", hooks: [theirs] }] });
});

/** Every file in a repository's working tree, its exclude file, pre-push hook and remote config: what setup can change. */
function snapshot(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true, encoding: "utf8" })) {
    if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".git\\")) continue;
    const file = join(repo, rel);
    if (statSync(file).isFile()) out[rel] = readFileSync(file, "utf8");
  }
  for (const rel of [".git/info/exclude", ".git/hooks/pre-push"]) if (existsSync(join(repo, rel))) out[rel] = readFileSync(join(repo, rel), "utf8");
  out["git config"] = git(repo, "config", "--get-regexp", "^remote\\.");
  return out;
}

test("a dry run lists what setup then changes, and changes nothing itself", async () => {
  const repo = await repoAt();
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(repo, "AGENTS.md"), "# Notes\n");
  const args = ["--repo", repo, "--agent", "claude-code,codex,cursor", "--pre-push"];
  const setup = (...more: string[]) => {
    const p = Bun.spawnSync(["bun", SETUP, ...args, ...more], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect(p.exitCode).toBe(0);
    return p.stdout.toString();
  };
  const listed = (out: string) => new Set(out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, l.indexOf(": "))));

  const before = snapshot(repo);
  const plan = listed(setup("--dry-run"));
  expect(snapshot(repo)).toEqual(before);
  expect(plan.size).toBeGreaterThan(0);

  setup();
  const after = snapshot(repo);
  const changed = new Set(Object.keys(after).filter((k) => after[k] !== before[k]));
  expect(plan).toEqual(changed);
  // Everything is done now, so there's nothing left to list.
  expect(listed(setup("--dry-run")).size).toBe(0);
}, 60_000);
