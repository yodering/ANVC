/**
 * `anvc open`: one server per project, found again rather than started twice.
 *
 * Every server here binds in 7520-7539, clear of the ones a person runs, and
 * is stopped by the pid its record names. No test starts a real browser:
 * tests/preload.ts sets ANVC_NO_BROWSER, and the tests that open one put a
 * fake on a PATH that holds nothing else.
 */
import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openWorkLog, recordFile, type Running } from "../protocol/open";
import { readJson, samePath, writeJson } from "../protocol/rawlog";
import { cli, gitRepo, setEnv, tmp, tool, uiFetch } from "./helpers";

const PORTS = "7520-7539";

/** Opens a project's work log and stops its server when the test ends. */
async function open(repo: string) {
  const opened = await openWorkLog(repo, { ports: PORTS });
  onTestFinished(() => stop(repo));
  return opened;
}

function stop(repo: string) {
  const kept = readJson<Running | null>(recordFile(repo), null);
  try { if (kept) process.kill(kept.pid); } catch { /* already gone */ }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A folder holding only git, bun and fakes of the commands that open a browser or the desktop app. */
function fakes(): { bin: string; opened: string } {
  const bin = tmp("anvc-fake-bin-");
  const opened = join(bin, "opened");
  for (const name of ["git", "bun"]) symlinkSync(Bun.which(name)!, join(bin, name));
  for (const name of ["xdg-open", "open", "anvc-desktop"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${opened}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, opened };
}

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 50 && !existsSync(file); i++) await Bun.sleep(50);
  return readFileSync(file, "utf8");
}

test("opening a project again reuses its server, and another project gets its own", async () => {
  const [a, b] = [gitRepo({ commit: true }), gitRepo({ commit: true })];
  const first = await open(a);
  expect(first.reused).toBe(false);
  expect(first.browser).toBe(false);
  const again = await open(a);
  expect(again.reused).toBe(true);
  expect(again.url).toBe(first.url);
  const other = await open(b);
  expect(other.reused).toBe(false);
  expect(other.url).not.toBe(first.url);
  const name = async (url: string) => ((await (await uiFetch(`${url}/api/repo`)).json()) as { name: string }).name;
  expect(await name(first.url)).toBe(basename(a));
  expect(await name(other.url)).toBe(basename(b));
  // The clone's server bundles its page from where it runs.
  const page = await (await uiFetch(first.url)).text();
  const js = page.match(/src="([^"]+\.js)"/)![1]!;
  expect(await (await uiFetch(new URL(js, first.url).href)).text()).toContain("Untitled attempt");
}, 30_000);

test("a record whose process is gone, or whose server shows another project, is replaced", async () => {
  const [a, b] = [gitRepo({ commit: true }), gitRepo({ commit: true })];
  const gone = Bun.spawn([process.execPath, "-e", ""]);
  await gone.exited;
  const nothing = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = nothing.port!;
  nothing.stop(true);
  writeJson(recordFile(a), { repo: a, port, pid: gone.pid });
  const fresh = await open(a);
  expect(fresh.reused).toBe(false);
  const kept = readJson<Running>(recordFile(a), { repo: "", port: 0, pid: 0 });
  expect(kept.pid).not.toBe(gone.pid);
  expect(alive(kept.pid)).toBe(true);

  // A live server, but b's: a starts its own and leaves b's running.
  const theirs = await open(b);
  const bPid = readJson<Running>(recordFile(b), { repo: "", port: 0, pid: 0 }).pid;
  stop(a);
  writeJson(recordFile(a), { repo: a, port: Number(new URL(theirs.url).port), pid: bPid });
  const own = await open(a);
  expect(own.reused).toBe(false);
  expect(own.url).not.toBe(theirs.url);
  expect(alive(bPid)).toBe(true);
}, 30_000);

test("a port someone else took after its server stopped is never sent the token", async () => {
  const [a, b] = [gitRepo({ commit: true }), gitRepo({ commit: true })];
  const real = await open(b);
  // It passes the question on to a real server on another port, and answers
  // anything else as a server for a would.
  const tokens: Array<string | null> = [];
  const squatter = Bun.serve({
    port: 0,
    async fetch(request) {
      tokens.push(request.headers.get("x-anvc-token"));
      const url = new URL(request.url);
      if (url.pathname === "/api/hello") return fetch(`${real.url}/api/hello${url.search}`);
      return Response.json({ repo: a, pid: process.pid, code: "c" });
    },
  });
  onTestFinished(() => squatter.stop(true));
  writeJson(recordFile(a), { repo: a, port: squatter.port, pid: 1 });
  const own = await open(a);
  expect(own.reused).toBe(false);
  expect(own.url).not.toBe(`http://127.0.0.1:${squatter.port}`);
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.every((t) => t === null)).toBe(true);
}, 30_000);

// Skipped on Windows: the stand-ins for the browser and the desktop app are sh scripts.
test.skipIf(process.platform === "win32")("the browser is opened with a code that signs in once, never with the token", async () => {
  const repo = gitRepo({ commit: true });
  const started = await open(repo);
  const { bin, opened } = fakes();
  setEnv({ PATH: bin, ANVC_NO_BROWSER: undefined, DISPLAY: ":99" });
  const again = await open(repo);
  expect(again.browser).toBe(true);
  const line = await waitFor(opened);
  const link = new URL(line.trim().split(" ").at(-1)!);
  expect(`${link.protocol}//${link.host}`).toBe(started.url);
  const code = link.searchParams.get("t")!;
  expect(code).not.toBe(process.env.ANVC_UI_TOKEN);
  const signIn = () => fetch(link, { redirect: "manual" }).then((r) => r.headers.get("set-cookie") ?? "");
  expect(await signIn()).toContain(`anvc_ui=${process.env.ANVC_UI_TOKEN}`);
  expect(await signIn()).toBe("");
}, 30_000);

test.skipIf(process.platform === "win32")("anvc_open opens the browser and answers without the token or the code", async () => {
  const repo = gitRepo({ commit: true });
  const { url } = await open(repo);
  const { bin, opened } = fakes();
  const text = tool(repo, "anvc_open", {}, { PATH: bin, ANVC_NO_BROWSER: "", DISPLAY: ":99" });
  expect(text).toBe(`Opened the work log for ${samePath(repo)} in the browser, at ${url}.`);
  const code = new URL((await waitFor(opened)).trim().split(" ").at(-1)!).searchParams.get("t")!;
  expect(text).not.toContain(process.env.ANVC_UI_TOKEN!);
  expect(text).not.toContain(code);
}, 30_000);

test.skipIf(process.platform === "win32")("--desktop starts the desktop app on the project, or says how to get it", async () => {
  const repo = gitRepo({ commit: true });
  const { bin, opened } = fakes();
  setEnv({ PATH: bin });
  expect(cli(repo, "open", "--desktop").out).toBe(`Opened the desktop app on ${samePath(repo)}.\n`);
  expect((await waitFor(opened)).trim()).toBe(`anvc-desktop --repo ${samePath(repo)}`);
  rmSync(join(bin, "anvc-desktop"));
  const missing = cli(repo, "open", "--desktop");
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("`anvc desktop install` installs it");
}, 30_000);
