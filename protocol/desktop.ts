/**
 * The desktop app: finding it, and installing it from the latest release,
 * for `anvc desktop install` and the question `bun run setup` asks.
 *
 * The release workflow (.github/workflows/desktop.yml) attaches an installer
 * for each system to the release. Installing downloads the one for this
 * computer and hands it to the system's own installer: on macOS the .dmg
 * opens in Finder to drag to Applications, on Windows the setup .exe runs,
 * and on Linux apt installs the .deb, asking for the password in the
 * terminal. Without apt, the AppImage goes in ~/.local/bin.
 *
 * The installers' names are the ones `tauri build` writes, checked here for
 * the Linux .deb and AppImage. The macOS and Windows names and install
 * folders weren't checked against a release yet.
 */
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the installers are released. The public export names the public repository instead. */
export const RELEASES = "yodering/anvc";

export interface Asset { name: string; url: string }

const which = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" });

/**
 * The installer to download for a system and processor. The workflow builds
 * macOS on Apple silicon and the rest on x64, so an Intel Mac or an ARM PC
 * finds none.
 */
export function installerFor(assets: Asset[], platform: string = process.platform, arch: string = process.arch, apt = Boolean(which("apt"))): Asset | null {
  const arm = arch === "arm64";
  const suffix = platform === "darwin" ? `_${arm ? "aarch64" : "x64"}.dmg`
    : platform === "win32" ? `_${arm ? "arm64" : "x64"}-setup.exe`
      : platform === "linux" ? (apt ? `_${arm ? "arm64" : "amd64"}.deb` : `_${arm ? "aarch64" : "amd64"}.AppImage`)
        : null;
  return suffix ? assets.find((a) => a.name.endsWith(suffix)) ?? null : null;
}

/**
 * The command that starts the installed app, or null when it isn't
 * installed. The .deb puts it on the PATH, the AppImage goes in
 * ~/.local/bin, macOS finds an app by its name, and the Windows installer
 * puts it under the person's AppData or, for the .msi, Program Files.
 */
export function desktopCommand(): string[] | null {
  const onPath = which("anvc-desktop");
  if (onPath) return [onPath];
  const local = join(homedir(), ".local", "bin", "anvc-desktop");
  if (process.platform === "linux" && existsSync(local)) return [local];
  if (process.platform === "darwin") {
    const app = ["/Applications/anvc.app", join(homedir(), "Applications", "anvc.app")].find(existsSync);
    return app ? ["open", "-n", app, "--args"] : null;
  }
  if (process.platform === "win32") {
    const folders = [process.env.LOCALAPPDATA, process.env.ProgramFiles].filter(Boolean).map((f) => join(f!, "anvc"));
    const exe = folders.flatMap((f) => ["anvc-desktop.exe", "anvc.exe"].map((n) => join(f, n))).find(existsSync);
    return exe ? [exe] : null;
  }
  return null;
}

/** The latest release's installers, through gh when it's here, since the development repository is private. */
async function latestAssets(repo: string): Promise<{ tag: string; assets: Asset[] }> {
  if (which("gh")) {
    const p = Bun.spawnSync(["gh", "api", `repos/${repo}/releases/latest`], { stdout: "pipe", stderr: "pipe" });
    if (p.success) return release(JSON.parse(p.stdout.toString()));
  }
  const answer = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (answer.status === 404) throw new Error(`No release of ${repo} can be downloaded yet. If one is published, the repository is private: install gh and sign in with gh auth login.`);
  if (!answer.ok) throw new Error(`Couldn't read ${repo}'s latest release: GitHub answered ${answer.status}.`);
  return release(await answer.json());
}

const release = (body: { tag_name: string; assets: Array<{ name: string; url: string }> }) =>
  ({ tag: body.tag_name, assets: body.assets.map((a) => ({ name: a.name, url: a.url })) });

/** Downloads an asset by its API address, which works for a private repository with gh's token. */
async function download(asset: Asset, into: string): Promise<string> {
  const file = join(into, asset.name);
  if (which("gh")) {
    const p = Bun.spawnSync(["gh", "api", "-H", "accept: application/octet-stream", asset.url.replace("https://api.github.com/", "")], { stdout: "pipe", stderr: "pipe" });
    if (p.success) { writeFileSync(file, p.stdout); return file; }
  }
  const answer = await fetch(asset.url, { headers: { accept: "application/octet-stream" } });
  if (!answer.ok) throw new Error(`Couldn't download ${asset.name}: GitHub answered ${answer.status}.`);
  writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
  return file;
}

/**
 * Downloads this computer's installer from the latest release and starts
 * it. Returns what happened, in a sentence, for the person.
 */
export async function installDesktop(repo: string = RELEASES): Promise<string> {
  const { tag, assets } = await latestAssets(repo);
  const asset = installerFor(assets);
  if (!asset) {
    return `${repo}'s release ${tag} has no desktop app for ${process.platform} on ${process.arch}. From a clone of ANVC, \`bun run desktop:build\` builds one.`;
  }
  // A new folder only this user can open: on Linux /tmp is shared, and a
  // folder with a name anyone could guess could be made first by another
  // user, who could then swap the .deb before sudo installs it.
  const file = await download(asset, mkdtempSync(join(tmpdir(), "anvc-desktop-")));
  if (process.platform === "darwin") {
    spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
    return `Opened ${asset.name}. Drag anvc to Applications in the window that opened.`;
  }
  if (process.platform === "win32") {
    spawn(file, [], { detached: true, stdio: "ignore" }).unref();
    return `Started the installer, ${asset.name}. Follow it to finish.`;
  }
  if (asset.name.endsWith(".deb")) {
    const command = ["sudo", "apt", "install", "-y", file];
    // sudo asks for the password in the terminal, and an agent's shell has
    // none. On a desktop, pkexec asks in a window instead.
    if (!process.stdin.isTTY) {
      const windowed = which("pkexec") && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
      if (windowed && Bun.spawnSync(["pkexec", "apt", "install", "-y", file], { stdout: "ignore", stderr: "ignore" }).success) {
        return `Installed the desktop app from ${asset.name}. Reopen it to use the new version.`;
      }
      return `Downloaded ${asset.name}. To install it, run: ${command.join(" ")}`;
    }
    const p = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return p.success ? `Installed the desktop app from ${asset.name}. It's in your app menu as anvc.` : `apt couldn't install it. To try again: ${command.join(" ")}`;
  }
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(file, join(bin, "anvc-desktop"));
  chmodSync(join(bin, "anvc-desktop"), 0o755);
  return `Put the desktop app in ${join(bin, "anvc-desktop")}. An AppImage needs FUSE; if it doesn't start, install libfuse2.`;
}
