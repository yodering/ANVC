/**
 * Each agent's tools, read from fixture config files under a temp HOME and
 * CLAUDE_CONFIG_DIR, and the project's notes on when to use them.
 *
 * Bun reads HOME once, when a process starts, so everything that reads the
 * agents' configs runs as a subprocess with the fixture's environment: the
 * CLI, the MCP server and the UI server. The real ~/.claude, ~/.codex and
 * ~/.cursor are never read.
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeAssist } from "../protocol/assist";
import { buildIndex, openIndex, QUOTED, tried } from "../protocol/query";
import { validateRecord, type CheckpointRecord } from "../protocol/record";
import { currentNotes, listNotes, notesBriefing, writeNote, type AgentTools, type Tool } from "../protocol/tools";
import { turns } from "../server/api";
import { context, uiFetch as fetchWithToken, git, gitRepo, rec, served, tmp, tool } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const person = { kind: "person" as const };

/** Every value a config below hides somewhere. None may appear in any output. */
const SECRETS = [
  "QUERYSECRET123", "HEADERSECRET999", "ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234", "ENVSECRET777", "HOOKSECRET111",
  "CODEXQUERY666", "CODEXBEARER444", "CODEXHEADER555", "CODEXENV333",
  "CURSORENV222", "sk-abcdefghijklmnopqrstuvwxyz0123", "PATHSECRET12345678",
  // Shapes redaction doesn't know: only the program and its package are shown.
  "DBURLSECRET55", "PATSECRET4242",
];

const put = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const hook = (command: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });

/** A project, and a HOME holding Claude Code's, Codex's and Cursor's configs in the shapes each writes. */
function fixture() {
  const repo = gitRepo({ commit: true });
  const home = tmp("anvc-tools-home-");
  const claude = join(home, "claude-config");
  const { CODEX_HOME: _codex, ...inherited } = process.env;
  const env = { ...inherited, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude } as Record<string, string>;
  const plugins = join(claude, "plugins/cache");

  // Claude Code, for every project.
  put(join(claude, "settings.json"), {
    hooks: {
      SessionStart: [hook("TOKEN=HOOKSECRET111 bash /opt/sounds/notify.sh start")],
      Stop: [hook("bash /opt/sounds/notify.sh stop")],
      UserPromptSubmit: [hook('bun "/opt/anvc"/emitters/claude-code/inject.ts UserPromptSubmit')],
    },
    enabledPlugins: { "anvc@anvc": true, "helper@tools": false },
    skillOverrides: { "quiet-skill": "off" },
  });
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside it.
  put(join(claude, ".claude.json"), {
    mcpServers: { figma: { type: "http", url: "https://mcp.figma.example/mcp?key=QUERYSECRET123", headers: { Authorization: "Bearer HEADERSECRET999" } } },
    projects: {
      [repo]: {
        mcpServers: { "local-db": { command: "npx", args: ["db-mcp", "--token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234", "postgresql://app:DBURLSECRET55@db/prod", "--pat", "PATSECRET4242"], env: { DB_PASSWORD: "ENVSECRET777" } } },
        disabledMcpServers: ["figma"],
      },
    },
  });
  put(join(claude, "plugins/installed_plugins.json"), {
    version: 2,
    plugins: {
      "anvc@anvc": [{ scope: "user", installPath: join(plugins, "anvc") }],
      "ponytail@ponytail": [{ scope: "local", projectPath: repo, installPath: join(plugins, "ponytail") }],
      "helper@tools": [{ scope: "user", installPath: join(plugins, "helper") }],
      "elsewhere@tools": [{ scope: "local", projectPath: "/somewhere/else", installPath: join(plugins, "elsewhere") }],
    },
  });
  put(join(plugins, "anvc/.claude-plugin/plugin.json"), { name: "anvc", mcpServers: { anvc: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"] } } });
  put(join(plugins, "anvc/hooks/hooks.json"), { hooks: { SessionStart: [hook('bun "${CLAUDE_PLUGIN_ROOT}"/dist/inject.js SessionStart', "startup")] } });
  put(join(plugins, "anvc/commands/init.md"), "Make records travel\n");
  put(join(plugins, "ponytail/.claude-plugin/plugin.json"), { name: "ponytail", hooks: "./hooks/claude-hooks.json" });
  put(join(plugins, "ponytail/hooks/claude-hooks.json"), { hooks: { SessionStart: [hook('node "${CLAUDE_PLUGIN_ROOT}/hooks/ponytail-activate.js"')] } });
  put(join(plugins, "ponytail/skills/ponytail-audit/SKILL.md"), "---\nname: ponytail-audit\n---\n");
  put(join(plugins, "helper/.claude-plugin/plugin.json"), { name: "helper" });
  put(join(plugins, "helper/.mcp.json"), { mcpServers: { "helper-db": { command: "helper-db" } } });
  put(join(claude, "skills/my-skill/SKILL.md"), "---\nname: my-skill\n---\n");
  put(join(claude, "skills/quiet-skill/SKILL.md"), "---\nname: quiet-skill\n---\n");

  // Claude Code, for this project.
  put(join(repo, ".mcp.json"), {
    mcpServers: {
      anvc: { command: "bun", args: ["${CLAUDE_PROJECT_DIR:-.}/protocol/mcp.ts"] },
      pending: { command: "node", args: ["pending.js"] },
      refused: { command: "node", args: ["refused.js"] },
    },
  });
  put(join(repo, ".claude/settings.local.json"), {
    enabledMcpjsonServers: ["anvc"], disabledMcpjsonServers: ["refused"], enabledPlugins: { "ponytail@ponytail": true },
  });
  put(join(repo, ".claude/settings.json"), { hooks: { PostToolUse: [hook('bun "$CLAUDE_PROJECT_DIR"/emitters/claude-code/capture.ts PostToolUse', "Read|Edit")] } });
  put(join(repo, ".claude/skills/proj-skill/SKILL.md"), "---\nname: proj-skill\n---\n");

  // Codex.
  const codexHooks = join(home, ".codex/hooks.json");
  put(join(home, ".codex/config.toml"), [
    "[mcp_servers.hf]", 'url = "https://hf.example/mcp?t=CODEXQUERY666"', 'bearer_token = "CODEXBEARER444"',
    "[mcp_servers.hf.http_headers]", 'Authorization = "Bearer CODEXHEADER555"',
    "[mcp_servers.search]", 'command = "npx"', 'args = ["search-mcp"]', "enabled = false",
    "[mcp_servers.search.env]", 'API_KEY = "CODEXENV333"',
    "[mcp_servers.anvc]", 'command = "bun"', 'args = ["/opt/anvc/protocol/mcp.ts"]',
    `[hooks.state.${JSON.stringify(`${codexHooks}:session_start:0:0`)}]`, 'trusted_hash = "sha256:aa"',
    `[hooks.state.${JSON.stringify(`${codexHooks}:stop:0:0`)}]`, 'trusted_hash = "sha256:bb"', "enabled = false",
  ].join("\n"));
  put(codexHooks, {
    hooks: {
      SessionStart: [hook('bun "/opt/anvc"/emitters/claude-code/inject.ts SessionStart --agent codex')],
      Stop: [hook("python3 /opt/lint.py")],
      PostToolUse: [hook("bash /opt/log.sh")],
    },
  });
  put(join(repo, ".codex/hooks.json"), { hooks: { Stop: [hook("bash /opt/check.sh")] } });

  // Cursor.
  put(join(home, ".cursor/mcp.json"), {
    mcpServers: {
      anvc: { command: "bun", args: ["/opt/anvc/protocol/mcp.ts"], env: { ANVC_REPO: "${workspaceFolder}" } },
      notes: { command: "npx", args: ["notes-mcp", "--api-key=sk-abcdefghijklmnopqrstuvwxyz0123"], env: { TOKEN: "CURSORENV222" } },
    },
  });
  put(join(home, ".cursor/hooks.json"), {
    version: 1,
    hooks: {
      sessionStart: [{ command: 'bun "/opt/anvc"/emitters/claude-code/inject.ts SessionStart --agent cursor' }],
      stop: [{ command: "./hooks/format.sh" }],
    },
  });
  put(join(repo, ".cursor/mcp.json"), { mcpServers: { design: { url: "https://design.example/mcp/s/PATHSECRET12345678/x" } } });

  return { repo, home, env };
}

/** `anvc tools --json`, run with the fixture's HOME. */
function tools(repo: string, env: Record<string, string>): { raw: string; agents: AgentTools[]; notes: Array<{ tool: string; when: string }> } {
  const p = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), "tools", "--json", "--repo", repo], { env, stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).toBe("");
  const raw = p.stdout.toString();
  return { raw, ...JSON.parse(raw) };
}

const find = (agents: AgentTools[], agent: string, kind: Tool["kind"], name: string, where?: string) =>
  agents.find((a) => a.agent === agent)?.tools.find((t) => t.kind === kind && t.name === name && (!where || t.where === where));

test("each source is read, with where it's set up, whether it's on, and which are ANVC's", () => {
  const { repo, env } = fixture();
  const { agents } = tools(repo, env);
  const expectTool = (agent: string, kind: Tool["kind"], name: string, where: string, state: Tool["state"], anvc = false) => {
    const t = find(agents, agent, kind, name, where);
    expect(t, `${agent} ${kind} ${name} (${where})`).toBeDefined();
    expect({ name, state: t!.state, anvc: t!.anvc }).toEqual({ name, state, anvc });
  };

  // Claude Code: MCP servers for every project, this project and its .mcp.json.
  expectTool("claude-code", "mcp", "figma", "every project", "off");
  expectTool("claude-code", "mcp", "local-db", "this project", "on");
  expectTool("claude-code", "mcp", "anvc", "this project", "on", true);
  expectTool("claude-code", "mcp", "pending", "this project", "unknown");
  expectTool("claude-code", "mcp", "refused", "this project", "off");
  // Plugins, and what each brings.
  expectTool("claude-code", "plugin", "anvc", "every project", "on", true);
  expectTool("claude-code", "plugin", "ponytail", "this project", "on");
  expectTool("claude-code", "plugin", "helper", "every project", "off");
  expect(find(agents, "claude-code", "plugin", "elsewhere")).toBeUndefined();
  expectTool("claude-code", "mcp", "anvc", "anvc", "on", true);
  expectTool("claude-code", "hook", "inject.js", "anvc", "on", true);
  expectTool("claude-code", "command", "init", "anvc", "on", true);
  expectTool("claude-code", "hook", "ponytail-activate.js", "ponytail", "on");
  expectTool("claude-code", "skill", "ponytail-audit", "ponytail", "on");
  expectTool("claude-code", "mcp", "helper-db", "helper", "off");
  // Skills and hooks of its own.
  expectTool("claude-code", "skill", "my-skill", "every project", "on");
  expectTool("claude-code", "skill", "quiet-skill", "every project", "off");
  expectTool("claude-code", "skill", "proj-skill", "this project", "on");
  expectTool("claude-code", "hook", "notify.sh", "every project", "on");
  expect(find(agents, "claude-code", "hook", "notify.sh")!.events).toEqual(["SessionStart", "Stop"]);
  expectTool("claude-code", "hook", "inject.ts", "every project", "on", true);
  expectTool("claude-code", "hook", "capture.ts", "this project", "on", true);

  // Codex: a hook runs once reviewed, until it's switched off.
  expectTool("codex", "mcp", "hf", "every project", "on");
  expectTool("codex", "mcp", "search", "every project", "off");
  expectTool("codex", "mcp", "anvc", "every project", "on", true);
  expectTool("codex", "hook", "inject.ts", "every project", "on", true);
  expectTool("codex", "hook", "lint.py", "every project", "off");
  expectTool("codex", "hook", "log.sh", "every project", "unknown");
  expectTool("codex", "hook", "check.sh", "this project", "unknown");

  // Cursor keeps its MCP switches in its own settings, so the files can't say.
  expectTool("cursor", "mcp", "anvc", "every project", "unknown", true);
  expectTool("cursor", "mcp", "notes", "every project", "unknown");
  expectTool("cursor", "mcp", "design", "this project", "unknown");
  expectTool("cursor", "hook", "inject.ts", "every project", "on", true);
  expectTool("cursor", "hook", "format.sh", "every project", "on");
}, 30_000);

test("no secret in a config reaches the CLI, the MCP tool or the page's API, and names still do", async () => {
  const { repo, env } = fixture();
  const { raw, agents } = tools(repo, env);
  const text = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), "tools", "--repo", repo], { env, stdout: "pipe" }).stdout.toString();
  const answer = tool(repo, "anvc_tools", {}, env);
  const page = await served(repo, env, (origin) => fetchWithToken(`${origin}/api/tools`).then((r) => r.text()));
  for (const out of [raw, text, answer, page]) {
    expect(out).toContain("figma");
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  }
  // Names without values: what a person needs to recognise the entry.
  expect(find(agents, "claude-code", "mcp", "local-db")!.env).toEqual(["DB_PASSWORD"]);
  expect(find(agents, "claude-code", "mcp", "figma")!.headers).toEqual(["Authorization"]);
  expect(find(agents, "claude-code", "mcp", "figma")!.runs).toBe("https://mcp.figma.example");
  expect(find(agents, "codex", "mcp", "search")!.env).toEqual(["API_KEY"]);
  expect(find(agents, "cursor", "mcp", "notes")!.runs).toContain("notes-mcp");
}, 60_000);

test("notes fold: the latest wins, the history stays, and a fetched change doesn't replace one written here", () => {
  const repo = gitRepo({ commit: true });
  const first = writeNote(repo, "ponytail-audit", "cleanup audits", person);
  expect(first.replaced).toBe(false);
  const second = writeNote(repo, "Ponytail-Audit", "  over-engineering\n audits ", { kind: "agent", agent: "claude-code", session: "s1" });
  expect(second.replaced).toBe(true);
  let [note] = currentNotes(repo);
  expect(note).toMatchObject({ id: first.id, tool: "ponytail-audit", when: "over-engineering audits", by: "claude-code", remote: null });
  expect(note!.history.map((h) => h.when)).toEqual(["cleanup audits", "over-engineering audits"]);

  // A teammate's change to this note, fetched: shown nowhere as the note in force.
  const theirs = rec({ tool_note: { tool: "ponytail-audit", when: "never", of: first.id }, intent: { goal: "Tool note: ponytail-audit" } });
  asFetched(repo, theirs);
  [note] = currentNotes(repo);
  expect(note!.when).toBe("over-engineering audits");

  // A teammate's own note arrives quoted, with where it came from.
  asFetched(repo, rec({ tool_note: { tool: "figma", when: "a design link is shared" }, intent: { goal: "Tool note: figma" } }));
  const figma = currentNotes(repo).find((n) => n.tool === "figma")!;
  expect(figma.remote).toBe("origin");
  const block = notesBriefing(repo, 1200)!;
  expect(block).toContain('- figma: "a design link is shared" (from origin)');
  expect(block).toContain("- ponytail-audit: over-engineering audits");
  expect(block.endsWith(QUOTED)).toBe(true);
  // Whole notes only, within the budget.
  expect(notesBriefing(repo, 200)!.split("\n")).toEqual([
    "anvc: notes on when to use which tool in this project.", '- figma: "a design link is shared" (from origin)', QUOTED,
  ]);
  expect(listNotes(repo)).toHaveLength(2);

  expect(() => writeNote(repo, "two words", "x", person)).toThrow("one word");
  expect(() => writeNote(repo, "x", " ", person)).toThrow("Say when");
}, 30_000);

/** Writes a record under the ref `git fetch` gives a teammate's. */
function asFetched(repo: string, record: CheckpointRecord): string {
  const blob = Bun.spawnSync(["git", "-C", repo, "hash-object", "-w", "--stdin"], { stdin: new TextEncoder().encode(JSON.stringify(record)) }).stdout.toString().trim();
  const ref = `refs/remotes/origin/anvc/teammate/${String(Date.now() % 1e6).padStart(6, "0")}`;
  git(repo, "update-ref", ref, blob);
  return ref;
}

test("a note is checked like any record field, and isn't an attempt", () => {
  const ok = rec({ tool_note: { tool: "figma", when: "designs" } });
  expect(validateRecord(ok).tool_note!.tool).toBe("figma");
  expect(() => validateRecord(rec({ tool_note: { tool: "", when: "x" } }))).toThrow("tool_note.tool");
  expect(() => validateRecord(rec({ tool_note: { tool: "x", when: "y".repeat(301) } }))).toThrow("tool_note.when");
  expect(() => validateRecord({ ...ok, tool_note: { tool: "x", when: "y", of: ok.id } })).toThrow("tool_note.of");

  const repo = gitRepo({ commit: true });
  writeNote(repo, "figma", "design work", person);
  const db = openIndex();
  const records = new Map<string, CheckpointRecord>();
  buildIndex(db, repo, records);
  expect(records.size).toBe(1);
  expect(turns(db, records)).toEqual([]);
  expect(tried(db, "figma")).toEqual([]);
  db.close();
}, 30_000);

test("a session starts with the notes, again after compaction, and not when the person chose quiet", () => {
  const repo = gitRepo({ commit: true });
  const state = tmp("anvc-tools-state-");
  const env = { ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") };
  const start = (source: string, session = "s1") =>
    context("SessionStart", { hook_event_name: "SessionStart", session_id: session, cwd: repo, source }, env);

  expect(start("startup")).toBeUndefined();
  writeNote(repo, "ponytail-audit", "cleanup audits", person);
  const said = start("startup", "s2");
  expect(said).toContain("anvc: notes on when to use which tool in this project.\n- ponytail-audit: cleanup audits");
  expect(start("startup", "s2")).toBeUndefined();
  expect(start("compact", "s2")).toContain("- ponytail-audit: cleanup audits");

  writeAssist(repo, { level: "ask" });
  expect(start("startup", "s3")).toBeUndefined();
  writeAssist(repo, { moment: "tools", on: true });
  expect(start("startup", "s4")).toContain("ponytail-audit");
}, 60_000);

test("the CLI and the MCP tool write a note, and both list it by its tool", () => {
  const { repo, env } = fixture();
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), ...args, "--repo", repo], { env, stdout: "pipe", stderr: "pipe" });
  const wrote = cli("tool", "note", "ponytail-audit", "cleanup audits");
  expect(wrote.stdout.toString()).toContain("Saved the note for ponytail-audit.");
  const bad = cli("tool", "note", "ponytail-audit");
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain('usage: anvc tool note <name> "<when to use it>"');
  expect(cli("tools").stdout.toString()).toMatch(/on {6}ponytail-audit +ponytail plugin · note: cleanup audits/);

  expect(tool(repo, "anvc_tool_note", { tool: "figma", when: "a design link is shared" }, env)).toContain("Saved the note for figma.");
  const listed = tool(repo, "anvc_tools", { agent: "claude-code" }, env);
  expect(listed).toContain("figma");
  expect(listed).toContain("note: a design link is shared");
  expect(listed).not.toContain("Codex");
}, 60_000);

test("the page's API needs the token, and a note is written only from the page", async () => {
  const { repo, env } = fixture();
  await served(repo, env, async (origin) => {
    expect((await fetch(`${origin}/api/tools`)).status).toBe(401);
    const refused = await fetchWithToken(`${origin}/api/tools`, { method: "POST", body: JSON.stringify({ tool: "figma", when: "x" }) });
    expect(refused.status).toBe(403);
    const saved = await fetchWithToken(`${origin}/api/tools`, {
      method: "POST", headers: { "x-anvc": "1", "content-type": "application/json" }, body: JSON.stringify({ tool: "figma", when: "design work" }),
    });
    const view = await saved.json() as { agents: AgentTools[]; notes: Array<{ tool: string; when: string }> };
    expect(view.notes).toEqual([expect.objectContaining({ tool: "figma", when: "design work" })]);
    expect(find(view.agents, "claude-code", "mcp", "figma")).toBeDefined();
  });
}, 60_000);
