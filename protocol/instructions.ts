/**
 * The lines in AGENTS.md or CLAUDE.md that ask the agent to check past dead
 * ends and record its work. An agent that is never told to record doesn't,
 * and printing "add this line" meant most people never added it, so they go
 * into the file the agent already reads. The project commits that file, so
 * adding or removing them is the person's call.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { git } from "./git";

export const INSTRUCTION_LINES = [
  "Before starting a task, call anvc_dead_ends to see what was already abandoned here.",
  "After finishing or abandoning an attempt, record it with anvc_checkpoint.",
];

const files = (repo: string) => {
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  return ["AGENTS.md", "CLAUDE.md"].map((f) => resolve(top, f));
};
const read = (file: string) => readFileSync(file, "utf8");

/** AGENTS.md, else CLAUDE.md, whichever exists. */
export const instructionsFile = (repo: string): string | null => files(repo).find(existsSync) ?? null;

/** Whether that file tells the agent to record its work. */
export function instructionsOn(repo: string): boolean {
  const file = instructionsFile(repo);
  return file !== null && read(file).includes("anvc_checkpoint");
}

/** The file holding ANVC's lines, or null. */
export const instructionsIn = (repo: string): string | null =>
  files(repo).find((f) => existsSync(f) && INSTRUCTION_LINES.some((l) => read(f).includes(l))) ?? null;

/**
 * Adds the lines, unless the file mentions anvc_checkpoint already. Null when
 * there's no such file: none is created, since a tool that scatters files
 * through someone's tree is one they uninstall.
 */
export function addInstructions(repo: string, lines = INSTRUCTION_LINES): { file: string; added: boolean } | null {
  const file = instructionsFile(repo);
  if (!file) return null;
  const body = read(file);
  if (body.includes("anvc_checkpoint")) return { file: basename(file), added: false };
  writeFileSync(file, `${body.replace(/\s*$/, "")}\n\n${lines.join("\n")}\n`);
  return { file: basename(file), added: true };
}

/** Takes the lines out, and says from which file. Null when no file holds them. */
export function removeInstructions(repo: string): string | null {
  const file = instructionsIn(repo);
  if (!file) return null;
  const body = read(file).split("\n").filter((l) => !INSTRUCTION_LINES.includes(l.trim())).join("\n");
  writeFileSync(file, `${body.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`);
  return basename(file);
}
