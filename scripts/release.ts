/**
 * Cuts a release: the version everyone installing the plugin gets.
 *
 *   bun scripts/release.ts 0.2.0 [--no-commit]
 *
 * Sets the version, the desktop app's too, rebuilds plugin/ and writes the
 * marketplace file, then commits and tags. The plugin folder changes only here, so work on main
 * between releases reaches nobody: people get releases, not commits.
 *
 * Nothing is pushed. Push with tags, then export to the public repository,
 * which is where people install from.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const [next] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const commit = !process.argv.includes("--no-commit");

const pkgFile = join(root, "package.json");
const pkg = (await Bun.file(pkgFile).json()) as Record<string, unknown> & { version: string };
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`usage: bun scripts/release.ts <version>   (now ${pkg.version})`);
  process.exit(2);
}
if (Bun.semver.order(next, pkg.version) <= 0) {
  console.error(`${next} is not newer than ${pkg.version}`);
  process.exit(2);
}
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
if (commit && git("status", "--porcelain", "--untracked-files=no").stdout.toString().trim()) {
  console.error("Commit or stash your changes first; a release is one commit.");
  process.exit(1);
}

pkg.version = next;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
// The desktop app's installers are named for the version in tauri.conf.json,
// and Cargo keeps the app's own in Cargo.toml and Cargo.lock.
const DESKTOP = {
  "tauri.conf.json": /^( {2}"version": ")[^"]*(")/m,
  "Cargo.toml": /(\[package\][^[]*?\nversion = ")[^"]*(")/,
  "Cargo.lock": /(\nname = "anvc-desktop"\r?\nversion = ")[^"]*(")/,
};
for (const [name, pattern] of Object.entries(DESKTOP)) {
  const file = join(root, "src-tauri", name), text = readFileSync(file, "utf8");
  if (!pattern.test(text)) { console.error(`src-tauri/${name} has no version where release.ts looks for it.`); process.exit(1); }
  writeFileSync(file, text.replace(pattern, `$1${next}$2`));
}
const build = Bun.spawnSync(["bun", join(root, "scripts/build-plugin.ts"), join(root, "plugin")], { stdout: "inherit", stderr: "inherit" });
if (!build.success) process.exit(1);

// The marketplace people add is the public repository itself: /plugin
// marketplace add yodering/anvc, then /plugin install anvc@anvc.
mkdirSync(join(root, ".claude-plugin"), { recursive: true });
writeFileSync(join(root, ".claude-plugin/marketplace.json"), `${JSON.stringify({
  name: "anvc",
  owner: { name: "ANVC contributors" },
  description: "ANVC: version control for what coding agents tried, kept and abandoned.",
  plugins: [{
    name: "anvc",
    source: "./plugin",
    version: next,
    description: "Keeps what your coding agents tried, kept and abandoned, and shows them past dead ends before they repeat one.",
  }],
}, null, 2)}\n`);

if (!commit) {
  console.log(`Prepared ${next}. Nothing committed.`);
  process.exit(0);
}
git("add", "package.json", "plugin", ".claude-plugin/marketplace.json", ...Object.keys(DESKTOP).map((name) => `src-tauri/${name}`));
const made = git("commit", "-q", "-m", `Release ${next}`);
if (!made.success) { console.error(made.stderr.toString()); process.exit(1); }
git("tag", `v${next}`);
console.log(`Released ${next} as v${next}. Next:
  git push origin main --tags
  bash scripts/export-public.sh v${next} <public checkout>, then commit and push it there`);
