import { expect, test } from "bun:test";
import { chainLongerThan, diagram } from "../server/layout";
import type { Graph } from "../protocol/query";
import type { Structure } from "../protocol/structure";

function graph(over: Partial<Graph> = {}): Graph {
  return {
    files: [], links: [], authored: [], records: [], maps: [], ...over,
  } as Graph;
}

/** The project as read from the code, which is where edges now come from. */
function code(files: Array<Partial<Structure["files"][number]>> = []): Structure {
  return {
    files: files.map((f) => ({ path: "x.ts", lines: 10, imports: [], test: false, ...f })),
    unresolved: [],
  };
}
const part = (over: Record<string, unknown>) => ({
  id: "01JQZX9K4M7N8P2R3S5T6V7W8X", ts: "2026-09-22T10:00:00.000Z", part: "unnamed",
  does: "does something", reads: [], feeds: [], decisions: [], history: [], ...over,
}) as Graph["maps"][number];

test("an empty project draws nothing rather than an empty frame", async () => {
  const d = await diagram(graph(), code());
  expect(d.nodes).toHaveLength(0);
  expect(d.width).toBe(0);
});

test("parts are laid out with routed edges between them", async () => {
  const d = await diagram(graph({
    maps: [
      part({ part: "hooks", layer: "edge", feeds: [{ part: "store", what: "events" }] }),
      part({ part: "store", layer: "store" }),
    ],
  }), code());
  expect(d.nodes).toHaveLength(2);
  expect(d.edges).toHaveLength(1);
  // Laid left to right, so the source sits before its target.
  const [a, b] = [d.nodes.find((n) => n.id === "hooks")!, d.nodes.find((n) => n.id === "store")!];
  expect(a.x).toBeLessThan(b.x);
  // A routed edge carries real geometry and the words from the map.
  expect(d.edges[0]!.points.length).toBeGreaterThanOrEqual(2);
  expect(d.edges[0]!.what).toBe("events");
});

test("an edge naming a part nobody described is dropped, not invented", async () => {
  const d = await diagram(graph({
    maps: [part({ part: "hooks", feeds: [{ part: "nowhere", what: "x" }] })],
  }), code());
  expect(d.nodes.map((n) => n.id)).toEqual(["hooks"]);
  expect(d.edges).toHaveLength(0);
});

test("a box is sized to hold its own text", async () => {
  const [terse, wordy] = await Promise.all([
    diagram(graph({ maps: [part({ part: "a", does: "Short." })] }), code()),
    diagram(graph({ maps: [part({ part: "a", does: "A considerably longer description that has to wrap onto several separate lines to fit." })] }), code()),
  ]);
  // Reserving the label's real footprint is what makes overlap impossible.
  expect(wordy.nodes[0]!.h).toBeGreaterThan(terse.nodes[0]!.h);
});

test("attempts are attributed to the part that owns the file", async () => {
  const d = await diagram(graph({
    files: [{ path: "protocol/query.ts", name: "query.ts", dir: "protocol", records: 2, abandoned: 1, writes: 2, last: null }],
    records: [
      { id: "a", intent: "kept work", status: "kept", ts: "2026-09-01T00:00:00.000Z", files: ["protocol/query.ts"] },
      { id: "b", intent: "dead end", status: "abandoned", ts: "2026-09-02T00:00:00.000Z", files: ["protocol/query.ts"] },
    ],
    maps: [part({ part: "index", owns: ["protocol/"] })],
  }), code([{ path: "protocol/query.ts", lines: 40 }]));
  expect(d.nodes[0]!.attempts).toBe(2);
  expect(d.nodes[0]!.abandoned).toBe(1);
  // The file list comes from the code, and the line count with it.
  expect(d.nodes[0]!.files).toEqual(["protocol/query.ts"]);
  expect(d.nodes[0]!.lines).toBe(40);
});

test("a part owns every file in its directory, not only the ones work touched", async () => {
  const d = await diagram(graph({
    // One record, naming one file.
    records: [{ id: "a", intent: "x", status: "kept", ts: "2026-09-01T00:00:00.000Z", files: ["protocol/query.ts"] }],
    maps: [part({ part: "index", owns: ["protocol/"] })],
  }), code([
    { path: "protocol/query.ts", lines: 100 },
    { path: "protocol/record.ts", lines: 200 },
    { path: "protocol/git.ts", lines: 50 },
  ]));
  // The correction this rewrite exists for: three files, because there are
  // three, not one because one attempt touched one.
  expect(d.nodes[0]!.files).toHaveLength(3);
  expect(d.nodes[0]!.lines).toBe(350);
  expect(d.nodes[0]!.attempts).toBe(1);
});

test("wires come from imports, and carry the agent's words when it described one", async () => {
  const d = await diagram(graph({
    maps: [
      part({ part: "reader", owns: ["a/"], feeds: [{ part: "writer", what: "parsed rows" }] }),
      part({ part: "writer", owns: ["b/"] }),
    ],
  }), code([
    { path: "a/one.ts", imports: [] },
    // The import runs b -> a; the agent said a feeds b. The import decides
    // direction, the agent's sentence is only a label when it matches.
    { path: "b/two.ts", imports: ["a/one.ts"] },
  ]));
  // One wire, not two: the agent described the same relation from the other
  // end, so its sentence labels the import instead of contradicting it.
  expect(d.edges).toHaveLength(1);
  const [edge] = d.edges;
  expect(edge!.from).toBe("writer");
  expect(edge!.to).toBe("reader");
  expect(edge!.weight).toBe(1);
  expect(edge!.what).toBe("parsed rows");
});

test("a description pointing the other way labels the import rather than contradicting it", async () => {
  const d = await diagram(graph({
    maps: [
      // The agent says the reader feeds the writer. The import runs the other
      // way. Drawing both is what produced wires with eight bends looping
      // around the diagram.
      part({ part: "reader", owns: ["a/"], feeds: [{ part: "writer", what: "parsed rows" }] }),
      part({ part: "writer", owns: ["b/"] }),
    ],
  }), code([
    { path: "a/one.ts", imports: ["b/two.ts"] },
    { path: "b/two.ts" },
  ]));
  expect(d.edges).toHaveLength(1);
  const [edge] = d.edges;
  // Direction from the import, wording from the agent.
  expect(edge!.from).toBe("reader");
  expect(edge!.to).toBe("writer");
  expect(edge!.weight).toBe(1);
  expect(edge!.what).toBe("parsed rows");
});

test("a label is never placed outside the drawing", async () => {
  const d = await diagram(graph({
    maps: [
      part({ part: "a", owns: ["a/"], feeds: [{ part: "b", what: "a long description of what travels here" }] }),
      part({ part: "b", owns: ["b/"], feeds: [{ part: "c", what: "another long description of the payload" }] }),
      part({ part: "c", owns: ["c/"] }),
    ],
  }), code([
    { path: "a/x.ts", imports: ["b/x.ts"] },
    { path: "b/x.ts", imports: ["c/x.ts"] },
    { path: "c/x.ts" },
  ]));
  const left = Math.min(...d.nodes.map((n) => n.x));
  for (const edge of d.edges) {
    // A label floating in empty canvas is attached to nothing a reader can see.
    if (edge.label) expect(edge.label.x).toBeGreaterThanOrEqual(left - 1);
  }
});

test("a wire is labelled with two or three words, not a sentence", async () => {
  const d = await diagram(graph({
    maps: [
      part({ part: "a", owns: ["a/"], feeds: [{ part: "b", what: "scraped turns that become checkpoint records" }] }),
      part({ part: "b", owns: ["b/"] }),
    ],
  }), code([
    { path: "a/x.ts", imports: ["b/x.ts"] },
    { path: "b/x.ts" },
  ]));
  const [edge] = d.edges;
  expect(edge!.short).toBe("scraped turns");
  // The sentence survives for the panel; only the wire is shortened.
  expect(edge!.what).toBe("scraped turns that become checkpoint records");
});

test("a shortened label never ends on a dangling article", async () => {
  const d = await diagram(graph({
    maps: [
      part({ part: "a", owns: ["a/"], feeds: [{ part: "b", what: "new records the agent writes" }] }),
      part({ part: "b", owns: ["b/"] }),
    ],
  }), code([
    { path: "a/x.ts", imports: ["b/x.ts"] },
    { path: "b/x.ts" },
  ]));
  expect(d.edges[0]!.short).toBe("new records");
});

test("the layout measures text at the sizes the stylesheet draws it", async () => {
  // Two copies of these sizes drifted: the CSS went to 14px and the layout kept
  // measuring at 13, so every box was sized for smaller text than it held and
  // the badge row ran out past the edge. This reads the stylesheet itself.
  const { NODE_TEXT } = await import("../server/layout");
  const css = await Bun.file(new URL("../server/ui.css", import.meta.url)).text();
  const size = (cls: string) => Number(new RegExp(`\\.${cls}\\s*\\{[^}]*font-size:\\s*([\\d.]+)px`).exec(css)?.[1]);
  expect(size("fnode-title")).toBe(NODE_TEXT.title);
  expect(size("fnode-does")).toBe(NODE_TEXT.body);
  expect(size("fnode-badge")).toBe(NODE_TEXT.badge);
});

test("a box is wide enough for its badge row, or the row gives up a part", async () => {
  const d = await diagram(graph({
    records: Array.from({ length: 4 }, (_, i) => ({
      id: String(i), intent: "x", status: i === 0 ? "abandoned" : "kept",
      ts: "2026-09-01T00:00:00.000Z", files: ["app/a.ts"],
    })),
    maps: [part({ part: "the work log", owns: ["app/"] })],
  }), code(Array.from({ length: 17 }, (_, i) => ({
    path: `app/f${i}.ts`, lines: 250,
  })).concat([{ path: "app/a.ts", lines: 10 }])));
  const node = d.nodes[0]!;
  // SVG text collapses the separator's double spaces, so they are counted once.
  const row = node.badge.map((p) => p.text).join(" · ");
  // Approximate width at the badge size; what matters is it fits inside.
  const approx = [...row].length * 14.5 * 0.56;
  expect(approx).toBeLessThanOrEqual(node.w - 36);
  // "Abandoned" is what a reader looks for, so it is the last thing shed.
  expect(node.badge.some((p) => p.lost)).toBe(true);
  // The line count goes first, even though the file count comes first in the row.
  expect(node.badge.map((p) => p.text)).toEqual(["18 files", "4 attempts", "1 abandoned"]);
});

test("a description too long for the box ends in an ellipsis", async () => {
  const d = await diagram(graph({
    maps: [part({ part: "a", does: "The local page at 127.0.0.1:7000. Attempts newest first, one attempt in full, and the project map with every part drawn and every wire routed between them." })],
  }), code());
  const text = d.nodes[0]!.text;
  expect(text.length).toBe(3);
  expect(text[2]!.endsWith("…")).toBe(true);
});

test("a chain of more than five parts is found without walking every path", () => {
  const chain = (names: string[]) => names.slice(1).map((to, i) => ({ from: names[i]!, to }));
  const six = ["a", "b", "c", "d", "e", "f"];
  const five = six.slice(0, 5);
  expect(chainLongerThan(5, six, chain(six))).toBe(true);
  expect(chainLongerThan(5, five, chain(five))).toBe(false);
  // A cycle of five closes on itself and is still five parts long.
  expect(chainLongerThan(5, five, [...chain(five), { from: "e", to: "a" }])).toBe(false);

  // Every part feeding every other. Enumerating every simple path here is
  // about e·19! steps from each of twenty starts, which never finishes.
  const parts = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const dense = parts.flatMap((from) => parts.filter((to) => to !== from).map((to) => ({ from, to })));
  const began = performance.now();
  expect(chainLongerThan(5, parts, dense)).toBe(true);
  expect(performance.now() - began).toBeLessThan(1000);
});
