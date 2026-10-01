/**
 * Opens the work log for the project a folder is in: `anvc open`, the
 * plugin's /anvc:open and the anvc_open tool all come here.
 *
 * People run agents in several projects at once, so each project gets its
 * own server on its own port, and opening one again finds the server it
 * already has. A small record per project, under ANVC's state folder, names
 * that server's port and process.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitOrNull } from "./git";
import { readJson, repoKey, samePath, stateRoot, tokenProof, uiToken, writeJson } from "./rawlog";
import { HOME } from "./version";
import { desktopCommand, which } from "./desktop";

/**
 * The clone's server, or in the plugin, the bundle of it. It runs from its
 * own folder: the bundle finds its page and the map's layout worker by paths
 * relative to where it runs.
 */
const CLONE_SERVER = join(HOME, "server", "inspect.ts");
const SERVER = existsSync(CLONE_SERVER) ? CLONE_SERVER : join(HOME, "dist", "inspect.js");

/** Clear of `bun run inspect`'s 7000 and the desktop app's 7431-7450. Past the range, any free port. */
export const PORTS = "7451-7470";

export interface Running { repo: string; port: number; pid: number }

export interface Opened { repo: string; url: string; reused: boolean; browser: boolean }

/** The project a folder is in: the top of its git working folder. */
function projectOf(folder: string): string {
  const top = gitOrNull(folder, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`${folder} isn't in a git repository with a working folder.`);
  return top;
}

const place = (top: string, ext: string) => join(stateRoot(), "ui", `${repoKey(top)}.${ext}`);
export const recordFile = (top: string): string => place(top, "json");

/**
 * Asks a server which project it shows and for a sign-in code. Null when
 * nothing answers there, or something else does: another project, since the
 * Folders page can switch one, or a server with another token.
 *
 * The recorded port can outlive its server, and any user on this computer
 * can listen on it then, so the server first shows it holds the token, and
 * only then is the token sent.
 */
async function ask(port: number, top: string): Promise<{ repo: string; pid: number; code: string } | null> {
  try {
    const nonce = randomBytes(32).toString("hex");
    const hello = await fetch(`http://127.0.0.1:${port}/api/hello?n=${nonce}`, { signal: AbortSignal.timeout(2000) });
    const { proof } = (await hello.json()) as { proof?: unknown };
    const want = Buffer.from(tokenProof(uiToken(), port, nonce));
    if (typeof proof !== "string" || proof.length !== want.length || !timingSafeEqual(Buffer.from(proof), want)) return null;
    const answer = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST", headers: { "x-anvc-token": uiToken() }, signal: AbortSignal.timeout(2000),
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { repo: string; pid: number; code: string };
    return samePath(body.repo) === samePath(top) ? body : null;
  } catch { return null; }
}

/**
 * Starts a server detached: in its own process group, so it outlives the
 * command or agent that started it. With ANVC_UI_TOKEN set
 * it says which port it bound, into a log only this user can read. The
 * Update button restarts a clone's server through this too.
 */
export async function startServer(top: string, ports: string): Promise<number> {
  const log = place(top, "log");
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const out = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, [SERVER, "--repo", top, "--port", ports], {
    cwd: dirname(SERVER), detached: true, stdio: ["ignore", out, out], windowsHide: true,
    env: { ...process.env, ANVC_UI_TOKEN: uiToken() },
  });
  closeSync(out);
  child.unref();
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    const port = /^anvc listening 127\.0\.0\.1:(\d+)$/m.exec(readFileSync(log, "utf8"))?.[1];
    if (port) return Number(port);
    await Bun.sleep(100);
  }
  if (child.exitCode === null) child.kill();
  throw new Error(`The work log didn't start. What it printed is in ${log}`);
}

/**
 * Starts the browser on a link. Not without a display, and never under
 * ANVC_NO_BROWSER, which the tests set.
 */
function openBrowser(link: string): boolean {
  if (process.env.ANVC_NO_BROWSER) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const [name, ...args] = process.platform === "darwin" ? ["open", link]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", link]
      : ["xdg-open", link];
  const command = which(name!);
  if (!command) return false;
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => { /* nothing opened */ }).unref();
  return true;
}

/** Starts the desktop app on the project a folder is in, and returns the project. */
export function openDesktop(folder: string): string {
  const top = projectOf(folder);
  const app = desktopCommand();
  if (!app) throw new Error("The desktop app isn't installed. `anvc desktop install` installs it from the latest release.");
  spawn(app[0]!, [...app.slice(1), "--repo", top], { detached: true, stdio: "ignore" }).unref();
  return top;
}

/**
 * Opens the work log for the project a folder is in, starting its server
 * if it has none, and returns where it is. The browser opens unless
 * `browser` is false, there's no display, or ANVC_NO_BROWSER is set.
 * `restart` stops the server it finds first, so edited code runs.
 */
export async function openWorkLog(folder: string, options: { browser?: boolean; ports?: string; restart?: boolean } = {}): Promise<Opened> {
  const top = projectOf(folder);
  // The server's own answer decides, not whether the recorded process is
  // alive: the Update button restarts a server under a new process on the
  // same port, and the answer names that process.
  const kept = readJson<Running | null>(recordFile(top), null);
  let answer = kept ? await ask(kept.port, top) : null;
  if (answer && options.restart) {
    // It answered with this user's token, so the process it names is this user's.
    process.kill(answer.pid);
    for (let i = 0; i < 50 && await ask(kept!.port, top); i++) await Bun.sleep(100);
    answer = null;
  }
  let port = kept?.port ?? 0;
  const reused = answer !== null;
  if (!answer) {
    // Two opens of one project at the same moment can start two servers; the record keeps the last.
    port = await startServer(top, options.ports ?? PORTS);
    answer = await ask(port, top);
    if (!answer) throw new Error(`The work log started on port ${port} but doesn't answer for ${top}.`);
  }
  writeJson(recordFile(top), { repo: top, port, pid: answer.pid } satisfies Running);
  const url = `http://127.0.0.1:${port}`;
  const browser = options.browser !== false && openBrowser(`${url}/?t=${answer.code}`);
  return { repo: top, url, reused, browser };
}
