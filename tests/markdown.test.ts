/**
 * Writing rules read as formatted text on the Project page, and a tag in a
 * rule file is shown as text, never run.
 */
import { expect, test } from "bun:test";
import type { VNode } from "preact";
import { markdown } from "../server/markdown";

/** The elements as HTML, with text escaped the way Preact puts it in the page. */
function html(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (Array.isArray(node)) return node.map(html).join("");
  const { type, props } = node as VNode<{ children?: unknown; start?: number }>;
  expect(typeof type).toBe("string");
  return `<${type}${props.start ? ` start="${props.start}"` : ""}>${html(props.children)}</${type}>`;
}
const render = (text: string) => html(markdown(text));

test("headings, paragraphs, bold, italic and code", () => {
  expect(render("## Commit messages\n\nThe subject says **what changed**,\nin *plain* words: `git log`.")).toBe(
    "<h4>Commit messages</h4><p>The subject says <strong>what changed</strong>, in <em>plain</em> words: <code>git log</code>.</p>",
  );
  expect(render("### UI text\n#### Labels")).toBe("<h5>UI text</h5><h6>Labels</h6>");
  // Code keeps what's inside it, and an underscore inside a word is the word's.
  expect(render("Call `anvc_goal` or anvc_rule, not `**this**`; _this_ is italic.")).toBe(
    "<p>Call <code>anvc_goal</code> or anvc_rule, not <code>**this**</code>; <em>this</em> is italic.</p>",
  );
  expect(render("**Bold with *italic* inside.**")).toBe("<p><strong>Bold with <em>italic</em> inside.</strong></p>");
});

test("lists, nested lists and code blocks", () => {
  expect(render("- one\n  wrapped\n- two\n  1. first\n  2. second\n- three")).toBe(
    "<ul><li>one wrapped</li><li>two<ol><li>first</li><li>second</li></ol></li><li>three</li></ul>",
  );
  expect(render("Before\n3. third\n4. fourth")).toBe("<p>Before</p><ol start=\"3\"><li>third</li><li>fourth</li></ol>");
  expect(render("```bash\nbun run check\n\n# not a heading\n- not a list\n```\nAfter")).toBe(
    "<pre><code>bun run check\n\n# not a heading\n- not a list</code></pre><p>After</p>",
  );
});

test("HTML in a rule file is shown as text", () => {
  const out = render("<script>alert(1)</script>\n\n- <img src=x onerror=alert(1)>\n\n```\n<script>x</script>\n```\n\n**<b>bold</b>**");
  expect(out).toBe(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><ul><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>"
    + "<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre><p><strong>&lt;b&gt;bold&lt;/b&gt;</strong></p>",
  );
  // Every element is one the renderer made; html() fails on anything else.
  expect(out).not.toContain("<script");
});
