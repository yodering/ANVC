/**
 * The Markdown that writing rules are written in, as elements: headings,
 * paragraphs, lists, code blocks, and bold, italic and code inside a line.
 *
 * Everything else stays text. Nothing is parsed as HTML, so a tag in a rule
 * file is shown as the characters it is; a fetched rule set is anyone's text.
 * Links aren't made: a `javascript:` URL is one click from running.
 */
import type { VNode } from "preact";
import "./markdown.css";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
// Code first, so nothing inside it is formatted. An underscore inside a word,
// as in anvc_goal, is part of the word.
const INLINE = /(`+)(.+?)\1(?!`)|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|\*(?!\s)(.+?)(?<!\s)\*|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/s;

/** Bold, italic and code in one line of text. */
function inline(text: string): Array<string | VNode> {
  const out: Array<string | VNode> = [];
  let rest = text;
  for (let m = INLINE.exec(rest); m; m = INLINE.exec(rest)) {
    if (m.index) out.push(rest.slice(0, m.index));
    const key = out.length;
    if (m[1]) out.push(<code key={key}>{m[2]!.replace(/^ (.*) $/s, "$1")}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={key}>{inline((m[3] ?? m[4])!)}</strong>);
    else out.push(<em key={key}>{inline((m[5] ?? m[6])!)}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}

/** A list and the lists inside its items, from lines that start with its first item. */
function list(lines: string[], key: number): VNode {
  const [, indent, marker] = ITEM.exec(lines[0]!)!;
  const items: Array<{ text: string[]; inner: string[] }> = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    const last = items.at(-1);
    if (m && m[1]!.length <= indent!.length) items.push({ text: [m[3]!], inner: [] });
    else if (m || last!.inner.length) last!.inner.push(line);
    else last!.text.push(line.trim());
  }
  const body = items.map((it, i) => (
    <li key={i}>{inline(it.text.join(" "))}{it.inner.length > 0 && list(it.inner, 0)}</li>
  ));
  const start = parseInt(marker!, 10);
  return Number.isNaN(start) ? <ul key={key}>{body}</ul> : <ol key={key} start={start === 1 ? undefined : start}>{body}</ol>;
}

/** Rule text as blocks, each one element. */
export function markdown(text: string): VNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: VNode[] = [];
  const starts = (line: string) => FENCE.test(line) || HEADING.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push(<pre key={out.length}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // Under the page's own h2 and h3, whatever level the file used.
      const Tag = `h${Math.min(6, Math.max(4, heading[1]!.length + 2))}` as "h4" | "h5" | "h6";
      out.push(<Tag key={out.length}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // A list runs to the next blank line, heading or fence; a paragraph also
    // stops where a list starts. Its lines join, so text wrapped at 80
    // columns doesn't wrap twice on a narrow screen.
    const isList = ITEM.test(line);
    const block: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !starts(lines[i]!) && (isList || !block.length || !ITEM.test(lines[i]!)); i++) block.push(lines[i]!);
    out.push(isList ? list(block, out.length) : <p key={out.length}>{inline(block.map((l) => l.trim()).join(" "))}</p>);
  }
  return out;
}
