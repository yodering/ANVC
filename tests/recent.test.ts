/**
 * The repositories setup offers: the ones agents worked in lately, newest
 * first, then the others in the usual project folders, never ANVC's own clone.
 * Run in a child process, since Bun's homedir ignores a HOME changed while running.
 */
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";

test("setup offers recent repositories first, then the ones found, and leaves out ANVC's clone", () => {
  const home = tmp("anvc-recent-home-");
  const code = join(home, "Desktop", "Gits");
  mkdirSync(code, { recursive: true });
  const [recent, found, clone] = ["recent", "found", "clone"].map((name) => {
    const dir = join(code, name);
    mkdirSync(dir);
    Bun.spawnSync(["git", "init", "-q", dir]);
    return dir;
  });
  // A Claude Code session that ran in a folder inside `recent`.
  mkdirSync(join(recent, "src"));
  const project = join(home, ".claude", "projects", "-recent");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "s.jsonl"), `${JSON.stringify({ type: "user", cwd: join(recent, "src") })}\n`);
  utimesSync(join(project, "s.jsonl"), new Date(), new Date());
  const p = Bun.spawnSync(["bun", "-e", `
    import { candidates } from "${join(import.meta.dir, "../protocol/recent")}";
    console.log(JSON.stringify(candidates([${JSON.stringify(clone)}])));
  `], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") }, stdout: "pipe", stderr: "pipe" });
  const list = JSON.parse(p.stdout.toString()) as Array<{ repo: string; by: string | null }>;
  expect(list.map((c) => c.repo.split("/").at(-1))).toEqual(["recent", "found"]);
  expect(list[0]!.by).toBe("Claude Code");
  expect(list[1]!.by).toBeNull();
});
