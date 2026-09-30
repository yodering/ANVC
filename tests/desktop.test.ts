/**
 * The desktop app's installer for each system, picked by the names
 * `tauri build` gives them. The Linux names are the ones it wrote here.
 */
import { expect, test } from "bun:test";
import { installerFor } from "../protocol/desktop";

const assets = [
  "anvc_0.3.9_aarch64.dmg", "anvc_aarch64.app.tar.gz", "anvc_0.3.9_x64-setup.exe", "anvc_0.3.9_x64_en-US.msi",
  "anvc_0.3.9_amd64.deb", "anvc_0.3.9_amd64.AppImage", "anvc-0.3.9-1.x86_64.rpm",
].map((name) => ({ name, url: `https://api.github.com/repos/o/r/releases/assets/${name}` }));
const pick = (platform: string, arch: string, apt = true) => installerFor(assets, platform, arch, apt)?.name ?? null;

test("each system gets its own installer, and one with no build gets none", () => {
  expect(pick("darwin", "arm64")).toBe("anvc_0.3.9_aarch64.dmg");
  expect(pick("win32", "x64")).toBe("anvc_0.3.9_x64-setup.exe");
  expect(pick("linux", "x64")).toBe("anvc_0.3.9_amd64.deb");
  expect(pick("linux", "x64", false)).toBe("anvc_0.3.9_amd64.AppImage");
  // The workflow builds macOS on Apple silicon only, and the rest on x64.
  expect(pick("darwin", "x64")).toBeNull();
  expect(pick("linux", "arm64")).toBeNull();
  expect(pick("freebsd", "x64")).toBeNull();
});
