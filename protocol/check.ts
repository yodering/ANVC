/**
 * Every number in a document, looked up: a README or a paper checked against
 * the runs, files and results behind it.
 *
 * Only numbers that read as results are taken: counts (38/50, "38 of 50"),
 * decimals, percentages and numbers with thousands separators. Bare integers
 * are left out; "50" is a sample size, a line count or a year far more often
 * than a result. So are code, links, dates, versions, and numbers that are
 * part of a name like v4c or S1.
 *
 * A short number like 5.7 is printed by something sooner or later. So a
 * print counts only if it came before the document last changed, and, when
 * the number shares its line with others (a table row), only if the same run
 * printed them too. Alone, it has to be a count or have three significant
 * digits, and only one command can have printed it. Anything short of that
 * is marked unsure, with the print that might be it.
 */
import { readFileSync, statSync } from "node:fs";
import { checkResult, listResults, significant, whence, type WhenceScope } from "./results";
import { mainStep } from "./runs";

/** One place a number appears: its line, and the other numbers and words in the same sentence or table row. */
interface DocNumber { text: string; line: number; beside: string[]; words: string[] }

type CheckState = "found" | "changed" | "unsure" | "missing";

export interface CheckRow {
  text: string;
  lines: number[];
  state: CheckState;
  /** Why it has that state, in a few words: "Printed with the numbers beside it". */
  reason: string;
  /** The file and key, or the recorded result, it was found in. */
  where?: string;
  /** The command that printed or wrote it, and the step of it that did the work. */
  by?: { command: string; step: string; ts: string };
  /** The printed line or file value it was matched to. */
  evidence?: string;
}

/** A row as one line of text, for the terminal and for agents. */
export function describeRow(r: CheckRow): string {
  return [r.reason, r.where, r.by && `${r.by.step} (${r.by.ts.slice(0, 10)})`].filter(Boolean).join(": ");
}

const ITEM = /(?<![\w.\/-])(?:(\d+) of (\d+)(?!\d)|(\d+)\/(\d+)(?![\w\/]|\.\d)|(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|-?\d+\.\d+(?:e[-+]?\d+)?%?|\d+(?:\.\d+)?e[-+]?\d+|\d+%))(?=x?(?:$|[^\w.]|\.(?!\d)))/gi;

/** Text that holds no result: code, links, dates, times and versions. */
function strip(raw: string): string {
  return raw
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+|\]\([^)]*\)/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\bv?\d+\.\d+\.\d+(?:[-.\w]*)?/g, " ")
    .replace(/\u2212/g, "-");
}

const STOP = new Set(["the", "and", "with", "for", "from", "that", "this", "was", "were", "are", "its", "into", "than", "then", "but", "all", "any", "per", "via", "against", "across", "both", "each", "only", "also", "which"]);

/** The words of a sentence or row, for telling which printed row it is. */
function wordsOf(text: string): string[] {
  return [...new Set(text.replace(ITEM, " ").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

const keyOf = (m: RegExpMatchArray) => m[1] !== undefined ? `${m[1]}/${m[2]}` : m[3] !== undefined ? `${m[3]}/${m[4]}` : m[5]!;

/**
 * Every place a number that reads as a result appears. Its neighbours are
 * the other numbers in its table row, or in its sentence, which in prose
 * often runs across a line break.
 */
/**
 * A LaTeX line as the words and numbers a reader sees: comments, citations
 * and labels gone, \num{0.881} and \SI{5.4}{\ms} as their numbers, 88.1\% as
 * 88.1%, 1{,}452 as 1,452.
 */
function unTex(line: string): string {
  return line
    .replace(/(?<!\\)%.*$/, "")
    .replace(/\\(?:cite[tp]?|ref|eqref|autoref|[cC]ref|label|url|href|includegraphics|input|include)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, " ")
    .replace(/\\(?:num|SI|qty|SIrange)\{([^}]*)\}(?:\{[^}]*\})?/g, "$1")
    .replace(/\{,\}/g, ",")
    .replace(/\\%/g, "%")
    .replace(/\\\\(\[[^\]]*\])?/g, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}$~]/g, " ");
}

export function numbersIn(text: string, options: { tex?: boolean } = {}): DocNumber[] {
  const tex = options.tex ?? false;
  const out: DocNumber[] = [];
  let fenced = false;
  let header: string[][] = [];
  let previous: string[][] = [];
  let rows = 0;
  let prose: Array<{ line: number; text: string }> = [];
  const flush = () => {
    // Sentences end at a stop followed by a space; "5.4 calls" doesn't end one.
    let sentence: Array<{ line: number; key: string }> = [];
    let said = "";
    const close = () => {
      const words = wordsOf(said);
      for (const n of sentence) out.push({ text: n.key, line: n.line, beside: [...new Set(sentence.map((o) => o.key).filter((k) => k !== n.key))], words });
      sentence = [];
      said = "";
    };
    for (const { line, text: t } of prose) {
      for (const part of t.split(/(?<=[.!?])\s+/)) {
        for (const m of part.matchAll(ITEM)) sentence.push({ line, key: keyOf(m) });
        said += ` ${part}`;
        if (/[.!?]\s*$/.test(part)) close();
      }
    }
    close();
    prose = [];
  };
  // One table row: a cell's words include its column's header.
  const tableRow = (cells: string[], at: number, whole: string) => {
    previous = cells.map(wordsOf);
    rows++;
    const row = cells.flatMap((cell, c) => [...cell.matchAll(ITEM)].map((m) => ({ key: keyOf(m), column: c })));
    const words = wordsOf(whole);
    for (const { key, column } of row) out.push({ text: key, line: at, beside: [...new Set(row.map((r) => r.key).filter((k) => k !== key))], words: [...new Set([...words, ...(header[column] ?? [])])] });
  };
  const endTable = () => { header = []; previous = []; rows = 0; };
  text.split(/\r?\n/).forEach((raw, i) => {
    const code = tex ? /\\(begin|end)\{(verbatim|lstlisting|minted|comment)\}/.exec(raw) : /^\s*(```|~~~)/.exec(raw);
    if (code) { flush(); fenced = tex ? code[1] === "begin" : !fenced; return; }
    if (fenced) return;
    if (tex) {
      // \midrule, or the first \hline after one row, ends a table's header.
      if (/\\(midrule|hline)\b/.test(raw) && !/(?<!\\)&/.test(raw)) {
        flush();
        if (/midrule/.test(raw) || rows === 1) header = previous;
        return;
      }
      if (/\\(begin|end)\{(tabular|table|tabularx|longtable)\*?\}/.test(raw)) { flush(); endTable(); return; }
      if (/(?<!\\)&/.test(raw)) {
        flush();
        const cells = raw.split(/(?<!\\)&/).map((c) => strip(unTex(c)));
        tableRow(cells, i + 1, cells.join(" "));
        return;
      }
      const line = strip(unTex(raw));
      if (!line.trim() || /^\s*\\(section|subsection|subsubsection|paragraph|chapter|item)\b/.test(raw)) flush();
      if (line.trim()) prose.push({ line: i + 1, text: line });
      return;
    }
    const line = strip(raw);
    if (/^\s*\|/.test(raw)) {
      flush();
      // The separator row under a table's first row makes that row the header.
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) { header = previous; return; }
      tableRow(line.split("|").slice(1, -1), i + 1, line);
      return;
    }
    endTable();
    if (!line.trim() || /^\s*(#|[-*+]\s|\d+\.\s)/.test(raw)) flush();
    if (line.trim()) prose.push({ line: i + 1, text: line });
  });
  flush();
  return out;
}

/** Specific enough that a print of it alone is telling: a count, or three significant digits. */
const telling = (text: string): boolean => /\d\s*\/\s*\d/.test(text) || significant(text) >= 3;

/** Each number in the document at `path`, with where it came from, if anything here knows. */
export function checkDocument(repo: string, path: string): CheckRow[] {
  const text = readFileSync(path, "utf8");
  const before = statSync(path).mtimeMs;
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  const page = flat(text);
  const scope: WhenceScope = { results: listResults(repo) };
  const all = scope.results!;
  const verdict = ({ text: number, beside, words }: DocNumber): Omit<CheckRow, "text" | "lines"> => {
    const w = whence(repo, number, 40, scope, { beside, words, before });
    // A printed line that is in the document word for word is the document
    // being printed (a cat, a script that reads it), not where it came from.
    const own = (o: { line: string }) => { const l = flat(o.line); return l.length >= 12 && page.includes(l); };
    w.outputs = w.outputs.filter((o) => !own(o));
    w.reads = w.reads.filter((o) => !own(o));
    const by = (o: { command: string; ts: string }) => ({ command: o.command, step: mainStep(o.command), ts: o.ts });
    const result = w.results[0];
    if (result) {
      const check = checkResult(repo, result, all);
      return { state: check.stale ? "changed" : "found", reason: check.stale ? "A recorded result, and what it depends on changed since" : "A recorded result", where: `${result.name} (${result.status})` };
    }
    const file = w.files[0];
    if (file) return { state: file.changed ? "changed" : "found", reason: file.changed ? "In a file a command wrote, and the file changed since" : "In a file a command wrote", where: `${file.path} → ${file.key}`, by: by(file), evidence: `${file.key} = ${file.found}` };
    // Printed with its neighbours, in one line or failing that in one output:
    // the one that fits its row best, by neighbours and words, unless another
    // command's fits as well. Common numbers like 0/10 are in every run.
    const best = (list: typeof w.outputs) => [...list].sort((a, b) => b.score! - a.score! || a.ts.localeCompare(b.ts));
    const inLine = best(w.outputs.filter((o) => o.beside));
    const inRun = best(w.outputs.filter((o) => !o.beside && o.same_run));
    const lead = inLine[0] ?? inRun[0];
    // The same line printed again, by the same analysis run a second way, is
    // the same result, not a rival.
    const differs = (o: (typeof w.outputs)[number]) => o.command !== lead!.command && flat(o.line) !== flat(lead!.line);
    const rival = (inLine[0] ? inLine : inRun).find((o) => differs(o) && o.score === lead!.score);
    if (lead && !rival) return { state: "found", reason: "Printed with the numbers beside it", by: by(lead), evidence: lead.line };
    if (lead) return { state: "unsure", reason: "More than one run printed it with the numbers beside it", by: by(lead), evidence: lead.line };
    // Alone, it has to be specific, printed by one command only (8/10 printed
    // by three runs could be any of them), in a line sharing a word with its
    // sentence: a sum across runs can match an unrelated column.
    const printed = best(w.outputs)[0] ?? w.outputs[0];
    // A line another command printed word for word counts as another print:
    // it may be a script reading the log back, or a second run that came out
    // the same.
    const commands = new Set([...w.outputs, ...w.reads.filter((r) => r.again)].map((o) => o.command)).size;
    if (printed && !beside.length && telling(number) && commands === 1 && (printed.score ?? 0) >= 1) return { state: "found", reason: "Printed", by: by(printed), evidence: printed.line };
    // In a data file: only when one file holds it, under a key named like
    // the text around it. A 1,452 turns up among thousands of samples.
    const inFiles = [...w.elsewhere].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const other = inFiles[0];
    const commit = other?.commit ? `, in commit ${other.commit}` : "";
    if (other && inFiles.length === 1 && (other.score ?? 0) >= 1) return { state: "found", reason: "In a data file", where: `${other.path} → ${other.key}${commit}`, evidence: `${other.key} = ${other.found}` };
    if (printed) {
      const reason = beside.length ? "Printed, but not with the numbers beside it"
        : commands > 1 ? `Printed by ${commands} different commands`
        : telling(number) ? "Printed, in a line that shares no words with its sentence"
        : "Printed, but too short to tell apart";
      return { state: "unsure", reason, by: by(printed), evidence: printed.line };
    }
    if (other) return { state: "unsure", reason: inFiles.length > 1 ? `In ${inFiles.length} data files` : "In a data file, under a name unlike the text around it", where: `${other.path} → ${other.key}${commit}`, evidence: `${other.key} = ${other.found}` };
    const reread = w.reads[0];
    if (reread) return { state: "unsure", reason: "Only read back from a file", by: by(reread), evidence: reread.line };
    return { state: "missing", reason: "No command here printed it, and no data file holds it" };
  };
  // The same number with the same neighbours gets the same answer: one row, every line.
  const rows = new Map<string, CheckRow>();
  const asked = new Map<string, Omit<CheckRow, "text" | "lines">>();
  for (const n of numbersIn(text, { tex: /\.(tex|ltx)$/i.test(path) })) {
    const question = `${n.text}|${[...n.beside].sort().join(",")}|${n.words.join(",")}`;
    const answer = asked.get(question) ?? verdict(n);
    asked.set(question, answer);
    const key = `${n.text}|${answer.state}|${describeRow({ text: n.text, lines: [], ...answer })}|${answer.evidence ?? ""}`;
    const row = rows.get(key) ?? { text: n.text, lines: [], ...answer };
    if (!row.lines.includes(n.line)) row.lines.push(n.line);
    rows.set(key, row);
  }
  return [...rows.values()];
}
