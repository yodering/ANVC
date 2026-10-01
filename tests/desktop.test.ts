/**
 * The desktop app's installer for each system, picked by the names
 * `tauri build` gives them. The Linux names are the ones it wrote here.
 */
import { expect, test } from "bun:test";
import { installerFor, installFile } from "../protocol/desktop";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";

const assets = [
  "anvc_0.3.9_aarch64.dmg", "anvc_aarch64.app.tar.gz", "anvc_0.3.9_x64-setup.exe", "anvc_0.3.9_x64_en-US.msi",
  "anvc_0.3.9_amd64.deb", "anvc_0.3.9_amd64.AppImage", "anvc-0.3.9-1.x86_64.rpm",
].map((name) => ({ name, url: `https://api.github.com/repos/o/r/releases/assets/${name}` }));
const pick = (platform: string, arch: string) => installerFor(assets, platform, arch)?.name ?? null;

test("each system gets an installer that needs no password, and one with no build gets none", () => {
  expect(pick("darwin", "arm64")).toBe("anvc_aarch64.app.tar.gz");
  expect(pick("win32", "x64")).toBe("anvc_0.3.9_x64-setup.exe");
  expect(pick("linux", "x64")).toBe("anvc_0.3.9_amd64.AppImage");
  // The workflow builds macOS on Apple silicon only, and the rest on x64.
  expect(pick("darwin", "x64")).toBeNull();
  expect(pick("linux", "arm64")).toBeNull();
  expect(pick("freebsd", "x64")).toBeNull();
});

// The real AppImage is 117 MB; these unpack the way it does, or fail to.
const appImage = (works: boolean) => {
  const image = join(tmp("anvc-desktop-dl-"), "anvc_0.4.6_amd64.AppImage");
  writeFileSync(`${image}.AppRun`, '#!/bin/sh\necho "ran $*"\n');
  writeFileSync(image, works ? `#!/bin/sh\nmkdir squashfs-root && cp "$0.AppRun" squashfs-root/AppRun && chmod +x squashfs-root/AppRun\n` : "#!/bin/sh\nexit 1\n");
  return image;
};

test.skipIf(process.platform !== "linux")("on Linux the app is unpacked into the home folder, with a launcher and a menu entry", () => {
  // A home whose path the shell would expand, run or split if it weren't quoted.
  const home = join(tmp("anvc-desktop-home-"), "J Smith $(touch pwned) `id`");
  expect(installFile(appImage(true), home)).toBe("Installed the desktop app. Reopen it to use the new version.");
  const launcher = join(home, ".local", "bin", "anvc-desktop");
  const ran = Bun.spawnSync([launcher, "--repo", "x"], { cwd: home });
  expect(ran.stdout.toString()).toBe("ran --repo x\n");
  expect(existsSync(join(home, "pwned"))).toBe(false);
  expect(readFileSync(join(home, ".local", "share", "applications", "anvc.desktop"), "utf8")).toContain('/J Smith \\\\$(touch pwned) \\\\`id\\\\`/.local/bin/anvc-desktop"\n');
  // A download that won't unpack leaves the app that ran.
  expect(installFile(appImage(false), home)).toStartWith("Couldn't unpack");
  expect(Bun.spawnSync([launcher]).stdout.toString()).toBe("ran \n");
});

test.skipIf(process.platform !== "darwin")("on macOS the app is unpacked into Applications", () => {
  const home = tmp("anvc-desktop-home-");
  const from = tmp("anvc-desktop-app-");
  mkdirSync(join(from, "anvc.app", "Contents"), { recursive: true });
  writeFileSync(join(from, "anvc.app", "Contents", "Info.plist"), "<plist/>");
  const tarball = join(from, "anvc_aarch64.app.tar.gz");
  Bun.spawnSync(["tar", "-czf", tarball, "-C", from, "anvc.app"]);
  // Never the real /Applications, which may hold the app this machine uses.
  const applications = tmp("anvc-applications-");
  expect(installFile(tarball, home, applications)).toBe("Installed the desktop app. Reopen it to use the new version.");
  expect(existsSync(join(applications, "anvc.app", "Contents", "Info.plist"))).toBe(true);
});
