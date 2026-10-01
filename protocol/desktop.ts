/**
 * The desktop app: finding it, and installing it from the latest release,
 * for `anvc desktop install` and the question `bun run setup` asks.
 *
 * The release workflow (.github/workflows/desktop.yml) attaches an installer
 * for each system to the release. Installing downloads the one for this
 * computer and installs it for this person only, so nothing asks for a
 * password and an agent can do it: on macOS the app goes in Applications, on
 * Windows the per-user installer runs without its wizard, and on Linux the
 * AppImage is unpacked into ~/.local, ahead of a .deb installed before.
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellWord } from "./args";

/** Where the installers are released. The public export names the public repository instead. */
export const RELEASES = "yodering/anvc";

export interface Asset { name: string; url: string }

/** A command on the PATH as it is now; Bun.which alone reads the one this process started with. */
export const which = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" });

/**
 * The installer to download for a system and processor. The workflow builds
 * macOS on Apple silicon and the rest on x64, so an Intel Mac or an ARM PC
 * finds none.
 */
export function installerFor(assets: Asset[], platform: string = process.platform, arch: string = process.arch): Asset | null {
  const arm = arch === "arm64";
  const suffix = platform === "darwin" ? `_${arm ? "aarch64" : "x64"}.app.tar.gz`
    : platform === "win32" ? `_${arm ? "arm64" : "x64"}-setup.exe`
      : platform === "linux" ? `_${arm ? "aarch64" : "amd64"}.AppImage`
        : null;
  return suffix ? assets.find((a) => a.name.endsWith(suffix)) ?? null : null;
}

/**
 * The command that starts the installed app, or null when it isn't
 * installed. The person's own copy comes first, since installing puts the
 * newest there: on Linux the launcher in ~/.local/bin before a .deb's on the
 * PATH, and on macOS ~/Applications before /Applications. The Windows
 * installer puts it under AppData or, for the .msi, Program Files.
 */
export function desktopCommand(): string[] | null {
  const local = join(homedir(), ".local", "bin", "anvc-desktop");
  if (process.platform === "linux" && existsSync(local)) return [local];
  const onPath = which("anvc-desktop");
  if (onPath) return [onPath];
  if (process.platform === "darwin") {
    const app = [join(homedir(), "Applications", "anvc.app"), "/Applications/anvc.app"].find(existsSync);
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

const INSTALLED = "Installed the desktop app. Reopen it to use the new version.";

/**
 * Downloads this computer's installer from the latest release and installs
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
  // user, who could then swap the installer before it runs.
  const into = mkdtempSync(join(tmpdir(), "anvc-desktop-"));
  const said = installFile(await download(asset, into));
  // Kept on a failure, which names the file to try by hand.
  if (said === INSTALLED) rmSync(into, { recursive: true, force: true });
  return said;
}

/**
 * Installs a downloaded installer for this person only. Returns what
 * happened, in a sentence. The new app is unpacked beside the old one and
 * swapped in only once that worked, so a bad download leaves the one that ran.
 */
export function installFile(file: string, home: string = homedir(), applications = "/Applications"): string {
  if (process.platform === "win32") {
    // Tauri's installer is per user, and /S runs it without the wizard.
    return Bun.spawnSync([file, "/S"], { windowsHide: true }).success ? INSTALLED : `The installer stopped. To run it yourself: ${file}`;
  }
  const swapIn = (unpacked: string, at: string) => {
    rmSync(at, { recursive: true, force: true });
    renameSync(unpacked, at);
  };
  if (process.platform === "darwin") {
    // An admin can write to /Applications without a password, and that's
    // where an app dragged from the .dmg went.
    let folder = applications;
    try { accessSync(folder, constants.W_OK); } catch { folder = join(home, "Applications"); }
    mkdirSync(folder, { recursive: true });
    const fresh = mkdtempSync(join(folder, ".anvc-"));
    const ok = Bun.spawnSync(["tar", "-xzf", file, "-C", fresh]).success && existsSync(join(fresh, "anvc.app"));
    if (ok) swapIn(join(fresh, "anvc.app"), join(folder, "anvc.app"));
    rmSync(fresh, { recursive: true, force: true });
    return ok ? INSTALLED : `Couldn't unpack ${file} into ${folder}.`;
  }
  // Unpacked, an AppImage needs no FUSE, which Ubuntu no longer installs.
  const dir = join(home, ".local", "share", "anvc-desktop");
  mkdirSync(dirname(dir), { recursive: true });
  const fresh = mkdtempSync(`${dir}-`);
  chmodSync(file, 0o755);
  const ok = Bun.spawnSync([file, "--appimage-extract"], { cwd: fresh, stdout: "ignore", stderr: "ignore" }).success && existsSync(join(fresh, "squashfs-root", "AppRun"));
  if (ok) swapIn(join(fresh, "squashfs-root"), dir);
  rmSync(fresh, { recursive: true, force: true });
  if (!ok) return `Couldn't unpack ${file}.`;
  // A script, not a link: AppRun finds its files from the path it was started by.
  const bin = join(home, ".local", "bin", "anvc-desktop");
  mkdirSync(dirname(bin), { recursive: true });
  rmSync(bin, { force: true });
  writeFileSync(bin, `#!/bin/sh\nexec ${shellWord(join(dir, "AppRun"))} "$@"\n`, { mode: 0o755 });
  // Named as the .deb's entry, so it takes that one's place in the app menu.
  // Exec is quoted, with the Desktop Entry spec's escapes, for a home with a space.
  const apps = join(home, ".local", "share", "applications");
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, "anvc.desktop"), [
    "[Desktop Entry]", "Name=anvc", "Comment=The anvc work log as a desktop app", `Exec="${bin.replace(/["`$\\]/g, "\\\\$&")}"`,
    `Icon=${join(dir, "anvc-desktop.png")}`, "StartupWMClass=anvc-desktop", "Terminal=false", "Type=Application", "",
  ].join("\n"));
  return INSTALLED;
}
