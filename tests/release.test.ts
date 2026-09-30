/**
 * A release: version set, the desktop app's too, plugin rebuilt, marketplace
 * written, one commit and a tag. Run in a clone, never in this checkout.
 */
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmp } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");

test("a release sets the version everywhere, commits once and tags", async () => {
  const dir = join(tmp("anvc-release-"), "anvc");
  Bun.spawnSync(["git", "clone", "-q", ROOT, dir], { stderr: "pipe" });
  // Not the shared git(): the commit below has nothing in it when this
  // checkout has no uncommitted changes, and that has to be allowed to fail.
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdout: "pipe", stderr: "pipe" });
  // The scripts as they are in this working tree, not as last committed.
  for (const file of ["scripts/release.ts", "scripts/build-plugin.ts", "scripts/hookfiles.ts"]) {
    await Bun.write(join(dir, file), Bun.file(join(ROOT, file)));
  }
  git("add", "-A"); git("commit", "-q", "-m", "Scripts under test");
  // The plugin carries the work log's server, which imports Preact and elkjs.
  // A clone has them after bun install; the ones this checkout resolves
  // stand in for that.
  const preact = Bun.resolveSync("preact", ROOT);
  const modules = `${sep}node_modules`;
  symlinkSync(preact.slice(0, preact.lastIndexOf(`${modules}${sep}`) + modules.length), join(dir, "node_modules"), "junction");
  const before = git("rev-list", "--count", "HEAD").stdout.toString().trim();
  const now = (await Bun.file(join(dir, "package.json")).json()).version as string;
  const [x, y] = now.split(".").map(Number);
  const next = `${x}.${y! + 1}.0`;

  // Refuses a version that is not newer.
  expect(Bun.spawnSync(["bun", join(dir, "scripts/release.ts"), now], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(2);

  const r = Bun.spawnSync(["bun", join(dir, "scripts/release.ts"), next], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect((await Bun.file(join(dir, "plugin/.claude-plugin/plugin.json")).json()).version).toBe(next);
  const market = await Bun.file(join(dir, ".claude-plugin/marketplace.json")).json();
  expect(market.plugins[0]).toMatchObject({ name: "anvc", source: "./plugin", version: next });
  // The desktop app's installers carry the same version.
  // As git checked them out, which on Windows can be with CRLF.
  const desktop = async (file: string) => (await Bun.file(join(dir, "src-tauri", file)).text()).replaceAll("\r\n", "\n");
  expect((await Bun.file(join(dir, "src-tauri/tauri.conf.json")).json()).version).toBe(next);
  expect(await desktop("Cargo.toml")).toContain(`[package]\nname = "anvc-desktop"\nversion = "${next}"\n`);
  expect(await desktop("Cargo.lock")).toContain(`name = "anvc-desktop"\nversion = "${next}"\n`);
  expect(git("status", "--porcelain", "--untracked-files=no").stdout.toString()).toBe("");
  expect(Number(git("rev-list", "--count", "HEAD").stdout.toString().trim())).toBe(Number(before) + 1);
  expect(git("tag", "--points-at", "HEAD").stdout.toString().trim()).toBe(`v${next}`);
}, 120_000);
