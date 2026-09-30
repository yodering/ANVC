#!/usr/bin/env bun
/**
 * Compiles the work log server into the binary the desktop app runs.
 *
 * Tauri runs an external binary as a "sidecar" only if its filename ends in the
 * target triple of the machine it was built for — `anvc-server` must exist as
 * `anvc-server-x86_64-unknown-linux-gnu` on this machine. The triple comes from
 * rustc rather than being guessed, because the wrong suffix fails at bundle time
 * with a message that does not say why.
 *
 * The server is the same one `bun run ui` starts. The desktop app is a window
 * around it, not a second implementation.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// From `rustc -vV`, which names the host on every version. `--print
// host-tuple` needs Rust 1.84, and Cargo.toml allows 1.77.2.
let triple: string | undefined;
try {
  triple = /^host: (\S+)$/m.exec(Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "pipe" }).stdout.toString())?.[1];
} catch { /* not installed */ }
if (!triple) {
  console.error("rustc not found. Install Rust: https://rustup.rs, then open a new terminal.");
  process.exit(1);
}

const outDir = resolve(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
// On Windows Tauri looks for anvc-server-<triple>.exe. bun build would add
// the .exe by itself; naming it here keeps the path printed below true.
const outfile = resolve(outDir, `anvc-server-${triple}${triple.includes("-windows") ? ".exe" : ""}`);

const build = Bun.spawnSync(
  ["bun", "build", "--compile", resolve(root, "server/inspect.ts"), "--outfile", outfile],
  { stdout: "inherit", stderr: "inherit", cwd: root },
);
if (!build.success) process.exit(build.exitCode ?? 1);
console.log(`sidecar: ${outfile}`);
