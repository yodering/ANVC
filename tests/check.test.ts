/**
 * A document's numbers, each traced to the run that printed it, or marked
 * unsure when the evidence could fit more than one thing.
 */
import { expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocument, numbersIn } from "../protocol/check";
import { gitRepo, setEnv, tmp, tool, writeCapture } from "./helpers";

test("a document's results are its counts, decimals and percentages, not its dates, versions or names", () => {
  const doc = [
    "# Run 3, 2026-09-27",
    "Released in 0.3.4 at 14:02; see `--lr 3e-4` and [the log](runs/v4c.log).",
    "The old format misled 18 of 30 episodes, and took 5.4 tool calls",
    "instead of 7.2. S1 and v4c are names.",
    "",
    "| Condition | passed | misled |",
    "| --- | ---: | ---: |",
    "| stale, old format | 30/30 | **5/30** |",
    "```",
    "0.8812 inside a code block",
    "```",
  ].join("\n");
  const found = numbersIn(doc);
  expect(found.map((n) => n.text)).toEqual(["18/30", "5.4", "7.2", "30/30", "5/30"]);
  // A sentence runs across the line break; its numbers are each other's neighbours.
  expect(found.find((n) => n.text === "7.2")).toMatchObject({ line: 4, beside: ["18/30", "5.4"] });
  // A cell takes its column's header as words.
  expect(found.find((n) => n.text === "5/30")!.words).toEqual(expect.arrayContaining(["stale", "old", "format", "misled"]));
});

test("a LaTeX paper reads the way it prints: \\num, \\SI, \\%, table columns, no comments or code", () => {
  const tex = [
    "\\section{Results}",
    "% 0.99 was dropped",
    "The old format misled \\num{18} of 30 episodes (see~\\cref{tab:main}), $p = 0.0004$.",
    "Accuracy reached 88.1\\% at \\SI{5.4}{\\milli\\second} per call, with 1{,}452 MiB moved.",
    "\\begin{tabular}{lrr}",
    "\\toprule",
    "Condition & passed & misled \\\\",
    "\\midrule",
    "stale, old format & 30/30 & \\textbf{5/30} \\\\",
    "\\end{tabular}",
    "\\begin{verbatim}",
    "0.8812",
    "\\end{verbatim}",
  ].join("\n");
  const found = numbersIn(tex, { tex: true });
  expect(found.map((n) => n.text)).toEqual(["18/30", "0.0004", "88.1%", "5.4", "1,452", "30/30", "5/30"]);
  expect(found.find((n) => n.text === "5/30")!.words).toEqual(expect.arrayContaining(["stale", "misled"]));
});

function project() {
  const repo = gitRepo();
  setEnv({ ANVC_CAPTURE_DIR: tmp("anvc-check-log-") });
  const run = (ts: string, command: string, output: string) => writeCapture(repo, [{ ts, tool: "Bash", command, output }]);
  const doc = (text: string, at: string) => {
    const path = join(repo, "README.md");
    writeFileSync(path, text);
    utimesSync(path, new Date(at), new Date(at));
    return checkDocument(repo, path);
  };
  return { repo, run, doc };
}

test("a table row is traced to the run that printed its numbers together", async () => {
  const p = project();
  p.run("2026-09-01T10:00:00Z", "python3 analyze.py run1.jsonl", "S0 stale record  30/30  4.9  0/30\nS1 stale, old format  30/30  5.4  5/30\n");
  p.run("2026-09-02T10:00:00Z", "python3 analyze.py run2.jsonl", "S0 stale record  50/50  5.4  0/50\nS1 stale, old format  50/50  5.3  5/50\n");
  const rows = p.doc("| Condition | passed | tools | misled |\n| --- | --- | --- | --- |\n| stale, old format | 30/30 | 5.4 | 5/30 |\n", "2026-09-03T00:00:00Z");
  // 5.4 is printed by both runs; only the first holds its row's other numbers.
  expect(rows.find((r) => r.text === "5.4")).toMatchObject({ state: "found", evidence: "S1 stale, old format  30/30  5.4  5/30" });
  expect(rows.find((r) => r.text === "5.4")!.by?.command).toContain("run1.jsonl");
});

test("a short number alone, a sum worked out by hand, and a print after the document are not found", async () => {
  const p = project();
  p.run("2026-09-01T10:00:00Z", "python3 analyze.py run1.jsonl", "units  S1 5/10  tools 5.4\ndates  S1 9/10\n");
  p.run("2026-09-05T10:00:00Z", "python3 total.py", "pooled 14/20\n");
  // A script that printed the document itself isn't where its numbers came from.
  p.run("2026-09-02T12:00:00Z", "python3 show.py README.md", "Across both tasks the old format misled 14/20 on units.\n");
  const rows = p.doc("Tools went up to 5.4 on average.\n\nAcross both tasks the old format misled 14/20 on units.\n", "2026-09-03T00:00:00Z");
  // 5.4 has two significant digits and nothing beside it: a guess.
  expect(rows.find((r) => r.text === "5.4")!.state).toBe("unsure");
  // 14/20 was printed, but two days after the document was written.
  expect(rows.find((r) => r.text === "14/20")!.state).toBe("missing");
});

test("a count printed by two different runs could be either", async () => {
  const p = project();
  p.run("2026-09-01T10:00:00Z", "python3 analyze.py run1.jsonl", "units  tried the workaround  8/10\n");
  p.run("2026-09-02T10:00:00Z", "python3 analyze.py run2.jsonl", "units  tried the workaround  8/10\n");
  p.run("2026-09-02T11:00:00Z", "python3 analyze.py run3.jsonl", "units  tried the workaround  7/10\n");
  const rows = p.doc("The kept record misled 8 of 10 on units.\n\nThen 7 of 10 tried the workaround on units.\n", "2026-09-03T00:00:00Z");
  expect(rows.find((r) => r.text === "8/10")).toMatchObject({ state: "unsure" });
  expect(rows.find((r) => r.text === "8/10")!.reason).toBe("Printed by 2 different commands");
  expect(rows.find((r) => r.text === "7/10")).toMatchObject({ state: "found" });
});

test("an agent checks a document through the MCP server, and only inside the repository", async () => {
  const p = project();
  p.run("2026-09-01T10:00:00Z", "python3 analyze.py run1.jsonl", "S1 stale, old format  30/30  5.4  5/30\n");
  p.doc("| stale, old format | 30/30 | 5.4 | 5/30 |\n\nWe also saw 0.123 somewhere.\n", "2026-09-03T00:00:00Z");
  const call = (args: object) => tool(p.repo, "anvc_results", args, { ANVC_SESSION: "s-mcp" });
  const text = call({ document: "README.md" });
  expect(text).toContain("README.md: 4 numbers checked");
  expect(text).toContain("3 found");
  expect(text).toContain("- 0.123 (line 3): No command here printed it");
  expect(call({ document: "../outside.md" })).toContain("outside this repository");
});

test("a claims table's row numbers and references to places aren't taken for values", () => {
  const doc = [
    "| # | Claim | Number |",
    "|---|---|---|",
    "| 2.1 | Deep Sets forecasts onsets | 0.909 AUC |",
    "| 2.2 | Earlier steps help, see row 2.1 | 0.877 |",
    "",
    "As Table 3 and section 4.2 show, the AUC is 0.915.",
  ].join("\n");
  const found = numbersIn(doc).map((n) => n.text);
  expect(found).toEqual(["0.909", "0.877", "0.915"]);
});
