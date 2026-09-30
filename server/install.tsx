/**
 * How this copy of ANVC is installed, and the commands the page shows for it.
 *
 * `bun run anvc` works only inside a clone of ANVC, and someone who
 * installed only the Claude Code plugin has none. A clone and the plugin run
 * their CLI by its path, and the plugin has slash commands for a few; the
 * desktop app has no CLI of its own, so its commands run in the clone it was
 * built from. The server says which (managedBy() in protocol/version.ts).
 */
import { useEffect, useState } from "preact/hooks";
import { getJson } from "./widgets";

/** What /api/version answers: which anvc this is, whether it has fallen behind, and how its commands start. */
export interface Install {
  version: string; managed: "git" | "plugin" | "desktop"; checked: string | null; behind: number; changes: string[];
  error: string | null; hooksBehind: boolean; cli: string; repo: string;
}

let asked: Promise<Install> | null = null;

export function useInstall(): Install | null {
  const [install, setInstall] = useState<Install | null>(null);
  useEffect(() => { void (asked ??= getJson<Install>("/api/version")).then(setInstall).catch(() => { asked = null; }); }, []);
  return install;
}

/** The plugin's slash commands, each the CLI command of the same name for this project. */
const SLASH = ["init", "on", "off", "open"];

/** The command that runs `anvc <args>` on this project. */
export const anvc = (i: Install, args: string): string =>
  i.managed === "plugin" && SLASH.includes(args) ? `/anvc:${args}` : `${i.cli} ${args} ${i.repo}`;
