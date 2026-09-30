/**
 * Which anvc this is, whether a newer one is out, and whether each repository
 * has the hooks this version expects.
 *
 * anvc runs from the folder it was cloned into, and nothing told anyone when
 * that folder fell behind. A `git pull` alone was half an update: hook
 * scripts changed at once, but hooks added since setup ran were never
 * installed, so a repository could miss failure capture or session copies
 * with no sign anything was missing.
 *
 * Updates are never applied by themselves. Code that runs inside every agent
 * session pulling itself is how one bad push reaches everyone at once, so
 * anvc says an update is ready, and `anvc update` or the page's Update button
 * applies it.
 */
import pkg from "../package.json" with { type: "json" };
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { gitOrNull } from "./git";
import { isRepo, readJson, writeJson } from "./rawlog";

/** Where this copy of anvc lives: the folder hooks and the MCP server run from. */
export const HOME = resolve(import.meta.dir, "..");

/**
 * This copy's command line, for commands and hooks that name it: protocol/cli.ts
 * in a clone, and dist/cli.js in the plugin. The plugin's work log and MCP
 * server are bundles of their own, so the one running isn't always the CLI.
 */
export const CLI = [join(HOME, "protocol", "cli.ts"), join(HOME, "dist", "cli.js")].find((p) => existsSync(p)) ?? Bun.main;

/** The setup script, in a clone. A plugin has none: its hooks come with it. */
export const SETUP = join(HOME, "scripts", "setup.ts");

/**
 * The revision of the hook set setup installs. Raised whenever setup adds,
 * removes or changes a hook, so a repository set up before can be told.
 * 4: PostToolUseFailure, SessionEnd, PostCompact and preCompact, stuck detection.
 * 5: ANVC's folder quoted in hook commands; the pre-push hook passes its remote.
 * 6: PreToolUse also on Bash, to give the writing rules for a git commit.
 * 7: PostToolUse also on WebFetch and WebSearch, to keep what they read as sources.
 * 8: SessionEnd, SubagentStart and SubagentStop captured, for Status.
 */
export const HOOKS_REVISION = 8;

/** Where the choices and lists for every project are kept: ~/.anvc. */
export const stateHome = (): string => process.env.ANVC_STATE_HOME ?? join(homedir(), ".anvc");

/** Each agent's own folder, where its settings for every project are kept. */
export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const codexDir = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");
export const cursorDir = (): string => join(homedir(), ".cursor");

export function version(): string {
  // A clone has package.json; an installed plugin has only its manifest.
  for (const file of ["package.json", ".claude-plugin/plugin.json"]) {
    try { return (JSON.parse(readFileSync(join(HOME, file), "utf8")) as { version?: string }).version ?? BUILT; }
    catch { /* try the next */ }
  }
  // Compiled into the desktop app there is no file beside the code at all,
  // and this read "0.0.0".
  return BUILT;
}

/** The version this code was built at, carried inside any bundle made of it. */
const BUILT: string = pkg.version;

/**
 * How this copy is kept up to date: a git clone is pulled with `anvc update`;
 * a plugin is updated by the agent's own plugin manager, which anvc leaves to
 * it. Compiled into the desktop app, the code lives on Bun's virtual
 * filesystem, and the app is rebuilt rather than updated in place. That
 * filesystem is /$bunfs on Linux and macOS and somewhere else on Windows, so
 * Bun is asked instead of the path.
 */
export const managedBy = (): "git" | "plugin" | "desktop" =>
  Bun.isStandaloneExecutable ? "desktop" : existsSync(join(HOME, ".git")) ? "git" : "plugin";

export interface Install { repo: string; agent: string; hooks: number; ts: string }

/** The repository name an install for every repository is kept under. */
export const GLOBAL = "*";

const installsFile = () => join(stateHome(), "installs.json");

export const installs = (): Install[] => readJson<Install[]>(installsFile(), []);

/** Every entry but this repository's for this agent, and `add`, written back. */
function writeInstalls(repo: string, agent: string, add?: Install): void {
  const same = isRepo(repo);
  const list = installs().filter((i) => !(i.agent === agent && same(i.repo)));
  writeJson(installsFile(), add ? [...list, add] : list);
}

/** Setup calls this, so `anvc update` knows every repository to bring up to date. */
export function noteInstall(repo: string, agent: string): void {
  try { writeInstalls(repo, agent, { repo, agent, hooks: HOOKS_REVISION, ts: new Date().toISOString() }); }
  catch { /* an update will then not know this repository; setup still worked */ }
}

/** Drops a repository's entry, once a global install has taken its hooks' place. */
export function forgetInstall(repo: string, agent: string): void {
  try { writeInstalls(repo, agent); } catch { /* setup still worked */ }
}

/**
 * Whether a repository's hooks for an agent are older than this version
 * expects. A repository with hooks but no entry was set up before entries
 * were kept, which is older than anything that keeps them.
 */
export function hooksBehind(repo: string, agent: string): boolean {
  // Installed for every repository, the global entry is the one that counts.
  // Setup keeps the path it was given, and a hook asks with git's, which on
  // Windows is C:/x where setup kept C:\x.
  const same = isRepo(repo);
  const entry = installs().find((i) => i.agent === agent && same(i.repo))
    ?? installs().find((i) => i.repo === GLOBAL && i.agent === agent);
  return !entry || entry.hooks < HOOKS_REVISION;
}

interface UpdateState {
  checked: string;
  /** Commits the remote has that this folder does not. */
  behind: number;
  /** Their subjects, newest first. */
  changes: string[];
  error?: string;
}

const updateFile = () => join(stateHome(), "update.json");

export function readUpdate(home = HOME): UpdateState | null {
  let state = readJson<UpdateState | null>(updateFile(), null);
  if (!state) return null;
  // The count is saved once a day, so a git pull since left it saying updates
  // were ready that were already here. Counting against the remote branch as
  // last fetched needs no network.
  if (state.behind) {
    const left = Number(gitOrNull(home, ["rev-list", "--count", "HEAD..@{u}"]));
    if (Number.isInteger(left) && left < state.behind) state = { ...state, behind: left, changes: state.changes.slice(0, left) };
  }
  return state;
}

/** Asks the remote this folder was cloned from whether it has moved on. */
export function checkForUpdate(home = HOME): UpdateState {
  const checked = new Date().toISOString();
  const upstream = gitOrNull(home, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return save({ checked, behind: 0, changes: [], error: "this copy of anvc has no remote branch to compare with" });
  const [remote] = upstream.split("/");
  const fetched = Bun.spawnSync(["git", "-C", home, "fetch", "--quiet", remote!], {
    stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true,
  });
  if (!fetched.success) return save({ checked, behind: 0, changes: [], error: "couldn't reach the anvc repository" });
  const subjects = (gitOrNull(home, ["log", "--format=%s", "HEAD..@{u}"]) ?? "").split("\n").filter(Boolean);
  return save({ checked, behind: subjects.length, changes: subjects.slice(0, 20) });
}

export function save(state: UpdateState): UpdateState {
  try { writeJson(updateFile(), state); } catch { /* checked again next time */ }
  return state;
}

/**
 * Starts a check in the background when the last one is a day old. Hooks call
 * this; they must never wait on the network, so the check runs detached and
 * its answer is read on a later turn.
 */
export function checkDaily(): void {
  if (process.env.ANVC_NO_UPDATE_NOTICE || managedBy() !== "git") return;
  try {
    const file = updateFile();
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 86_400_000) return;
    // Written first, so turns in the next few seconds do not start a second.
    save({ ...(readUpdate() ?? { behind: 0, changes: [] }), checked: new Date().toISOString() });
    // No shell: the folder anvc was cloned into can have any name.
    spawn("bun", [join(HOME, "protocol/cli.ts"), "update", "--check"], { detached: true, stdio: "ignore", windowsHide: true })
      .on("error", () => { /* no check today */ }).unref();
  } catch { /* no check today */ }
}

/** One plain line about updates, or null when there is nothing to say. */
export function updateLine(state: UpdateState | null): string | null {
  if (!state || !state.behind) return null;
  return `ANVC has ${state.behind} update${state.behind === 1 ? "" : "s"} ready. Run: bun run anvc update`;
}

/**
 * Pulls a copy of anvc forward. Fast-forward only: a copy with local commits
 * or edits is left alone and says why, rather than merged into.
 */
export function pullUpdate(home = HOME): { changes: string[]; depsChanged: boolean; error?: string } {
  const before = gitOrNull(home, ["rev-parse", "HEAD"]) ?? "";
  const lock = () => gitOrNull(home, ["rev-parse", "HEAD:bun.lock"]) ?? "";
  const lockBefore = lock();
  const pull = Bun.spawnSync(["git", "-C", home, "pull", "--ff-only", "--quiet"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true,
  });
  if (!pull.success) return { changes: [], depsChanged: false, error: pull.stderr.toString().trim().split("\n").at(-1) ?? "pull failed" };
  const after = gitOrNull(home, ["rev-parse", "HEAD"]) ?? "";
  const changes = before === after ? [] : (gitOrNull(home, ["log", "--format=%s", `${before}..${after}`]) ?? "").split("\n").filter(Boolean);
  return { changes, depsChanged: lock() !== lockBefore };
}

/**
 * Updates the Claude Code plugin with Claude Code's own commands: refresh the
 * marketplace, then install what it lists now. Null when the plugin isn't
 * installed or Claude Code isn't found.
 */
export function updatePlugin(): { from: string; to: string } | { error: string } | null {
  // Started from a desktop launcher, PATH can miss where Claude Code installs itself.
  const bin = Bun.which("claude", { PATH: `${process.env.PATH ?? ""}${delimiter}${join(homedir(), ".local", "bin")}` });
  if (!bin) return null;
  const claude = (...args: string[]) => Bun.spawnSync([bin, "plugin", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const installed = (): string | null => {
    try {
      const list = JSON.parse(claude("list", "--json").stdout.toString()) as { installed?: Array<{ id: string; version: string }> };
      return list.installed?.find((p) => p.id === "anvc@anvc")?.version ?? null;
    } catch { return null; }
  };
  const from = installed();
  if (!from) return null;
  for (const args of [["marketplace", "update", "anvc"], ["update", "anvc@anvc"]]) {
    const run = claude(...args);
    if (!run.success) return { error: run.stderr.toString().trim().split("\n").at(-1) || `claude plugin ${args.join(" ")} failed` };
  }
  return { from, to: installed() ?? from };
}

/**
 * Brings ANVC up to date wherever it's installed here: the clone this runs
 * from, pulled and set up again wherever it was set up, and the Claude Code
 * plugin. `anvc update` and the page's Update button both run this.
 */
export function update(): { ok: boolean; changed: boolean; lines: string[] } {
  const lines: string[] = [];
  let changed = false;
  if (managedBy() === "git") {
    const { changes, depsChanged, error } = pullUpdate();
    if (error) return { ok: false, changed, lines: [`Couldn't update ${HOME}:`, `  ${error}`, "If you changed files there, commit or stash them first."] };
    changed = changes.length > 0;
    lines.push(changed
      ? `Updated to ${version()} with ${changes.length} change${changes.length === 1 ? "" : "s"}:\n${changes.slice(0, 15).map((c) => `  ${c}`).join("\n")}`
      : `anvc ${version()} is already up to date.`);
    if (depsChanged) {
      lines.push("Dependencies changed; installed them.");
      Bun.spawnSync(["bun", "install"], { cwd: HOME, stdout: "ignore", stderr: "ignore", windowsHide: true });
    }
    // Set up again wherever it was set up, so hooks added since are there.
    const places = installs().filter((i) => i.repo === GLOBAL || existsSync(i.repo));
    for (const i of places) {
      const run = Bun.spawnSync(["bun", SETUP,
        ...(i.repo === GLOBAL ? ["--global"] : ["--repo", i.repo, "--no-instructions"]), "--agent", i.agent], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      lines.push(`${run.success ? "✓" : "✗"} ${i.repo === GLOBAL ? "every repository" : i.repo} (${i.agent})`);
    }
    if (!places.length) lines.push("No repositories are recorded as set up yet; run setup in each one to bring its hooks up to date.");
    save({ checked: new Date().toISOString(), behind: 0, changes: [] });
  }
  const plugin = updatePlugin();
  if (plugin && "error" in plugin) return { ok: false, changed, lines: [...lines, `Couldn't update the Claude Code plugin: ${plugin.error}`] };
  if (plugin) {
    changed ||= plugin.to !== plugin.from;
    lines.push(plugin.to !== plugin.from ? `Updated the Claude Code plugin from ${plugin.from} to ${plugin.to}.` : `The Claude Code plugin is up to date (${plugin.from}).`);
  }
  if (!lines.length) lines.push("The ANVC plugin isn't installed in Claude Code, so there's nothing here to update.");
  if (changed) lines.push("Restart your agents so they use the new version.");
  return { ok: true, changed, lines };
}
