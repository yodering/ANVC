/**
 * The desktop app's sidecar is named for this machine's target triple, read
 * from rustc, on any Rust the app's Cargo.toml allows.
 *
 * Skipped on Windows: the stand-ins for rustc and bun are sh scripts.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmp } from "./helpers";

/** Runs a copy of the script with a rustc that names `host`, and returns the file bun build was asked for. */
function sidecar(host: string): { root: string; outfile: string } {
  // A copy of the script, so what it builds lands in a temp folder.
  // The script resolves its own folder, and macOS's temp folder is behind a symlink.
  const root = realpathSync(tmp("anvc-sidecar-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/desktop-sidecar.ts"), readFileSync(resolve(import.meta.dir, "../scripts/desktop-sidecar.ts")));
  // rustc 1.77 has no `--print host-tuple`; bun build only says what it was asked.
  const bin = tmp("anvc-sidecar-bin-");
  writeFileSync(join(bin, "rustc"), `#!/bin/sh
[ "$1" = "-vV" ] || { echo "error: unknown print request: host-tuple" >&2; exit 1; }
printf 'rustc 1.77.2\\nhost: ${host}\\nrelease: 1.77.2\\n'
`, { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "$*" > "${join(bin, "built")}"\n`, { mode: 0o755 });

  const p = Bun.spawnSync([process.execPath, join(root, "scripts/desktop-sidecar.ts")], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
  });
  expect(p.exitCode, p.stderr.toString()).toBe(0);
  return { root, outfile: /--outfile (\S+)/.exec(readFileSync(join(bin, "built"), "utf8"))![1]! };
}

test.skipIf(process.platform === "win32")("the sidecar's triple comes from rustc older than 1.84", () => {
  const { root, outfile } = sidecar("aarch64-apple-darwin");
  expect(outfile).toBe(join(root, "src-tauri/binaries/anvc-server-aarch64-apple-darwin"));
});

test.skipIf(process.platform === "win32")("on Windows the sidecar is the .exe Tauri looks for", () => {
  const { root, outfile } = sidecar("x86_64-pc-windows-msvc");
  expect(outfile).toBe(join(root, "src-tauri/binaries/anvc-server-x86_64-pc-windows-msvc.exe"));
});
