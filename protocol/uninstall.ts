/**
 * Takes ANVC out of one repository, or out of every project.
 *
 * Setup changes up to five things in a project: three lines of git config,
 * hook files for each agent (kept out of commits through .git/info/exclude),
 * Cursor's MCP entry, an optional pre-push hook, and the project's own ANVC
 * settings under .git/anvc. uninstall() removes each, and turns ANVC off for
 * the folder so hooks installed for every project skip it too.
 *
 * Installed for every project, ANVC lives in each agent's own config instead:
 * the Claude Code plugin, hooks in ~/.codex and ~/.cursor, and MCP servers.
 * uninstallEverywhere() takes those out.
 *
 * Both find ANVC's entries with scripts/hookfiles.ts, as setup --global does,
 * so everything else in a file stays: a hook whose command runs one of ANVC's
 * scripts, an MCP server named anvc, and the plugin anvc@anvc with its
 * marketplace.
 *
 * Two things stay unless asked for, because they're the person's: records,
 * which are their history and may already be on the remote, and the lines in
 * AGENTS.md or CLAUDE.md, which is a file the project commits.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dropPlugin, dropServer, removeOurs } from "../scripts/hookfiles";
import { folders, setFolder } from "./folders";
import { git, gitOrNull, remoteNames, unconfigureRemote } from "./git";
import { instructionsIn, removeInstructions } from "./instructions";
import { removePrePush } from "./prepush";
import { plural, repoRoot } from "./activity";
import { readJson, writeJson } from "./rawlog";
import { claudeConfig, tilde } from "./tools";
import { claudeDir, codexDir, cursorDir, forgetInstall, GLOBAL, installs } from "./version";

const HOOK_FILES = [".claude/settings.local.json", ".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"];
const RECORD_REFS = ["refs/anvc/", "refs/anvc-private/", "refs/anvc-kept/", "refs/anvc-raw/", "refs/anvc-meta/"];

export interface Uninstalled { removed: string[]; kept: string[] }

type Json = Record<string, unknown>;

/** Every record ref in a clone, and the copies of shared ones fetched from a remote. */
const recordRefs = (repo: string): string[] => (gitOrNull(repo, ["for-each-ref", "--format=%(refname)", "refs/"]) ?? "").split("\n")
  .filter((r) => RECORD_REFS.some((p) => r.startsWith(p)) || /^refs\/remotes\/[^/]+\/anvc\//.test(r));

const deleteRefs = (repo: string, refs: string[]) => git(repo, ["update-ref", "--stdin"], { input: refs.map((r) => `delete ${r}\n`).join("") });

export function uninstall(given: string, opts: { records?: boolean; instructions?: boolean } = {}): Uninstalled {
  const repo = gitOrNull(given, ["rev-parse", "--show-toplevel"]);
  if (!repo) throw new Error(`not a git repository: ${given}`);
  const removed: string[] = [];
  const kept: string[] = [];
  const tracked = (rel: string) => gitOrNull(repo, ["ls-files", "--error-unmatch", rel]) !== null;
  const gone: string[] = [];
  // Setup lists the files it writes in .git/info/exclude; that's how an empty
  // one left by an earlier removal is known to be ANVC's and not the person's.
  const exclude = resolve(repo, git(repo, ["rev-parse", "--git-path", "info/exclude"]));
  const excluded = new Set(existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n").map((l) => l.trim()) : []);
  const leftover = (rel: string, data: Record<string, unknown>) =>
    Object.keys(data).every((k) => k === "version" || (k === "mcpServers" && !Object.keys(data[k] as object).length)) && excluded.has(rel) && !tracked(rel);

  setFolder(repoRoot(repo) ?? repo, false);
  removed.push("ANVC is off for this folder, so hooks installed for every project skip it");

  // Git config, for every remote setup was pointed at.
  for (const remote of remoteNames(repo)) {
    if (unconfigureRemote(repo, remote)) removed.push(`records no longer travel with git push and fetch on ${remote}`);
  }
  for (const key of ["anvc.privateRemote"]) if (gitOrNull(repo, ["config", "--unset-all", key]) !== null) removed.push(`git config ${key}`);

  // Hook files: only ANVC's entries go. A file left holding nothing of the
  // person's is deleted, unless the project commits it.
  for (const rel of HOOK_FILES) {
    const file = resolve(repo, rel);
    const data = readJson<Json | null>(file, null);
    if (!data) continue;
    const hooks = removeOurs(data);
    const plugin = rel === ".claude/settings.json" && dropPlugin(data);
    if (!hooks && !plugin) {
      if (leftover(rel, data)) { rmSync(file); gone.push(rel); }
      continue;
    }
    const empty = Object.keys(data).every((k) => k === "version");
    if (empty && !tracked(rel)) { rmSync(file); gone.push(rel); }
    else writeJson(file, data);
    removed.push(`${hooks ? plural(hooks, "hook") : "the plugin"} from ${rel}${tracked(rel) ? " (the project commits this file; commit the change)" : ""}`);
  }

  // Cursor's MCP entry.
  const mcp = resolve(repo, ".cursor/mcp.json");
  const servers = readJson<Json | null>(mcp, null);
  if (servers) {
    const had = dropServer(servers);
    const list = servers.mcpServers as Json | undefined;
    if (!list || !Object.keys(list).length) delete servers.mcpServers;
    if (!Object.keys(servers).length && (had || excluded.has(".cursor/mcp.json")) && !tracked(".cursor/mcp.json")) { rmSync(mcp); gone.push(".cursor/mcp.json"); }
    else if (had) writeJson(mcp, servers);
    if (had) removed.push("the MCP server from .cursor/mcp.json");
  }

  // The lines setup added to .git/info/exclude, for the files now gone.
  if (gone.length && existsSync(exclude)) {
    const lines = readFileSync(exclude, "utf8").split("\n");
    const left = lines.filter((l) => !gone.includes(l.trim()));
    if (left.length !== lines.length) writeFileSync(exclude, left.join("\n"));
  }
  if (gone.length) removed.push(`deleted ${gone.join(", ")}, which held nothing but ANVC's`);
  // A folder setup made for those files, now empty.
  for (const dir of [".claude", ".codex", ".cursor"]) {
    const path = resolve(repo, dir);
    try { if (existsSync(path) && !readdirSync(path).length) rmSync(path, { recursive: true }); } catch { /* left as it is */ }
  }

  // The pre-push hook, and the one it wrapped put back.
  const prePush = removePrePush(repo);
  if (prePush) removed.push(prePush);

  // The project's own settings: assist level, results, sharing, local only.
  const settings = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]), "anvc");
  if (existsSync(settings)) { rmSync(settings, { recursive: true, force: true }); removed.push("this project's ANVC settings (.git/anvc)"); }

  // Instruction lines: a file the project commits, so only when asked.
  const instructions = instructionsIn(repo);
  if (instructions && opts.instructions) removed.push(`the ANVC lines in ${removeInstructions(repo)} (commit the change)`);
  else if (instructions) kept.push(`the ANVC lines in ${basename(instructions)}; --instructions removes them`);

  // Records: this clone's history, and possibly already on the remote.
  const refs = recordRefs(repo);
  if (refs.length && opts.records) {
    deleteRefs(repo, refs);
    removed.push(`${plural(refs.length, "record")} from this clone`);
  } else if (refs.length) kept.push(`${plural(refs.length, "record")} in this clone; --records deletes them here`);
  const shared = refs.filter((r) => r.startsWith("refs/anvc/"));
  if (shared.length) kept.push(`records already pushed stay on the remote until you delete them there: git push <remote> --delete ${shared.length > 1 ? "<ref> …" : shared[0]}`);

  return { removed, kept };
}

/**
 * Takes ANVC out of every project: what `setup --global` put in each agent's
 * own config, and an MCP server registered for every project. With `dry`,
 * nothing is written and `removed` says what would go. Projects set up one
 * at a time keep their own hooks, since uninstall() in each is what removes
 * those.
 */
export function uninstallEverywhere(opts: { dry?: boolean; records?: boolean } = {}): Uninstalled {
  const removed: string[] = [];
  const kept: string[] = [];
  const edit = (file: string, take: (data: Json) => Array<string | false>) => {
    const data = readJson<Json | null>(file, null);
    const what = data ? take(data).filter(Boolean) : [];
    if (!what.length) return;
    if (!opts.dry) writeJson(file, data);
    removed.push(`${what.join(" and ")} from ${tilde(file)}`);
  };
  const hooks = (data: Json) => { const n = removeOurs(data); return n > 0 && plural(n, "hook"); };
  const server = (data: Json) => dropServer(data) && "the MCP server";

  let plugin = false;
  edit(join(claudeDir(), "settings.json"), (data) => {
    plugin = dropPlugin(data);
    return [plugin && "the plugin", hooks(data)];
  });
  // A server registered with `claude mcp add --scope user`. Ones registered
  // for a single project are that project's.
  edit(claudeConfig().file, (data) => [server(data)]);
  edit(join(codexDir(), "hooks.json"), (data) => [hooks(data)]);
  edit(join(cursorDir(), "hooks.json"), (data) => [hooks(data)]);
  edit(join(cursorDir(), "mcp.json"), (data) => [server(data)]);

  // Codex keeps its MCP servers in TOML, which `codex mcp add` wrote.
  const toml = join(codexDir(), "config.toml");
  const next = existsSync(toml) ? withoutCodexServer(readFileSync(toml, "utf8")) : undefined;
  if (next === null) kept.push(`the MCP server in ${tilde(toml)}; codex mcp remove anvc takes it out`);
  else if (next !== undefined) {
    if (!opts.dry) writeFileSync(toml, next);
    removed.push(`the MCP server from ${tilde(toml)}`);
  }

  if (!opts.dry) for (const i of installs().filter((i) => i.repo === GLOBAL)) forgetInstall(GLOBAL, i.agent);
  if (plugin) kept.push("the plugin's files in Claude Code; /plugin uninstall anvc@anvc deletes them");
  const one = new Set(installs().filter((i) => i.repo !== GLOBAL).map((i) => i.repo)).size;
  if (one) kept.push(`ANVC in ${plural(one, "project")} set up one at a time; anvc uninstall in each takes it out`);

  // Records, in every folder ANVC has run in.
  const places = folders().map((f) => [f.repo, recordRefs(f.repo)] as const).filter(([, refs]) => refs.length);
  const count = places.reduce((n, [, refs]) => n + refs.length, 0);
  if (count && opts.records) {
    if (!opts.dry) for (const [repo, refs] of places) deleteRefs(repo, refs);
    removed.push(`${plural(count, "record")} from ${plural(places.length, "project")}`);
    if (places.some(([, refs]) => refs.some((r) => r.startsWith("refs/anvc/")))) kept.push("records already pushed stay on each remote");
  } else if (count) kept.push(`${plural(count, "record")} in ${plural(places.length, "project")}; --records deletes them`);

  return { removed, kept };
}

/**
 * Codex's config.toml without the [mcp_servers.anvc] table `codex mcp add`
 * writes. Undefined when it has none. Null when taking the table out line by
 * line would change anything else: the result is read back and compared, so
 * a layout this doesn't expect is left for `codex mcp remove`.
 */
export function withoutCodexServer(text: string): string | null | undefined {
  const parse = (t: string): Json | null => { try { return Bun.TOML.parse(t) as Json; } catch { return null; } };
  const before = parse(text);
  const servers = before?.mcp_servers as Json | undefined;
  if (!before || !servers || !("anvc" in servers)) return undefined;
  let skip = false;
  const next = text.split("\n").filter((line) => {
    const table = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?/.exec(line)?.[1];
    if (table !== undefined) skip = table === "mcp_servers.anvc" || table.startsWith("mcp_servers.anvc.");
    return !skip;
  }).join("\n");
  delete servers.anvc;
  // An [mcp_servers] table left empty reads back as nothing at all.
  const same = (a: Json | null) => JSON.stringify(a, (k, v) => (k === "mcp_servers" && !Object.keys(v).length ? undefined : v));
  return same(parse(next)) === same(before) ? next : null;
}
