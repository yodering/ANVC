/**
 * Where every box and wire goes, computed here rather than in the browser.
 *
 * The first version of this map ran a force simulation over sixty file nodes
 * and produced exactly the hairball that force layouts produce on structured
 * data: labels overlapping into mush, and no way to tell what depended on
 * what. The fault was the choice, not the tuning — a force layout is for data
 * whose structure you do not know, and we know ours, because the agent wrote
 * it down.
 *
 * So layout is ELK's `layered` algorithm, the same family behind the
 * architecture diagrams people actually read: nodes ranked into columns by
 * dependency, wires routed orthogonally around boxes instead of through them.
 *
 * On the server for two reasons. The bundle is 3.1 MB, which is absurd to ship
 * to a browser for a sixteen-node diagram; and the layout is 93 ms, so there
 * is nothing to gain by moving it. The client receives coordinates.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { Graph, PartMap } from "../protocol/query";
import type { SourceFile, Structure } from "../protocol/structure";

/**
 * `elk.bundled.js` looks for a worker the Node way — `require("./elk-worker")`
 * — and that path fails under Bun with "undefined is not a constructor".
 * Importing the worker module directly instead hangs, because it expects to be
 * running inside worker scope already. Handing it a real Worker built from the
 * file URL is the one arrangement that works, and Bun supports web Workers
 * natively, so nothing else is needed.
 */
// Embedded as a file at build time. Resolving it from node_modules at runtime
// works from a checkout and fails from a compiled binary, which has no
// node_modules beside it.
import elkWorker from "elkjs/lib/elk-worker.min.js" with { type: "file" };
const elk = new ELK({ workerFactory: () => new Worker(elkWorker) } as never);

/** Reading order for the columns. A diagram that ranks randomly reads as noise. */
const LAYER_RANK: Record<string, number> = { edge: 0, tool: 1, core: 2, store: 3, surface: 4 };

export interface LaidNode {
  id: string;
  label: string;
  /** The one-line purpose, shown under the title when the box is big enough. */
  does: string;
  layer: string;
  x: number;
  y: number;
  w: number;
  h: number;
  attempts: number;
  abandoned: number;
  /** Every file this part owns, from the code — not only the ones work touched. */
  files: string[];
  /** Total lines across those files, so size on the map can mean size. */
  lines: number;
  /** The strings drawn in the box, already measured and cut to fit it. */
  title: string;
  text: string[];
  badge: BadgePart[];
  /**
   * The code changed after the description was written.
   *
   * The signal that keeps a map honest. A described part whose files have moved
   * underneath it is the exact thing that makes someone trust a stale diagram,
   * so it is shown on the node rather than buried.
   */
  stale: boolean;
}

export interface LaidEdge {
  id: string;
  from: string;
  to: string;
  /** What travels along this edge, in the agent's words. */
  what: string;
  /**
   * How many files cross this boundary. Zero means the relation was described
   * but no import backs it, which the renderer draws differently rather than
   * hiding.
   */
  weight: number;
  /** Polyline through the routed bend points, already in absolute coordinates. */
  points: Array<{ x: number; y: number }>;
  /** Where the label goes, chosen to sit on the wire and clear of other labels. */
  label?: { x: number; y: number };
  /** Two or three words for the wire itself; `what` stays for the panel. */
  short?: string;
}

/** The shape ELK hands back, narrowed to what is read. */
interface ElkResult {
  width?: number; height?: number;
  children?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }>;
  edges?: Array<{
    id: string; sources: string[]; targets: string[];
    labels?: Array<{ text?: string }>;
    sections?: Array<{
      startPoint: { x: number; y: number };
      endPoint: { x: number; y: number };
      bendPoints?: Array<{ x: number; y: number }>;
    }>;
  }>;
}

/**
 * The two or three words that name what travels along a wire.
 *
 * A sentence on a wire is unreadable at the size a wire label has to be, and
 * it spans the whole gap between two boxes, so it collides with its
 * neighbours. What a reader needs here is a name, not an explanation — the
 * explanation is one click away in the panel.
 *
 * Leading articles and the filler that starts most of these phrases go first,
 * then the remaining words are capped. "the candidate records for a prompt"
 * becomes "candidate records"; "scraped turns that become checkpoint records"
 * becomes "scraped turns".
 */
function shortLabel(what: string): string {
  const words = what
    .replace(/^(the|a|an|its|their|every|all)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    // Stop at the first connective: what follows is the qualifying clause,
    // which is exactly the part that belongs in the panel and not on a wire.
    if (out.length && /^(that|which|for|from|to|in|on|of|per|and|with|as|so|by)$/i.test(word)) break;
    out.push(word);
    if (out.length === 3) break;
  }
  // A phrase ending in an article or a comma was cut mid-thought — "new
  // records the", "record blob, rebuilt" — which reads worse than the shorter
  // honest version, so the dangling word goes.
  while (out.length > 1 && /^(the|a|an|its|their|and|or)$/i.test(out.at(-1)!)) out.pop();
  const short = (out.length ? out : words.slice(0, 2)).join(" ").replace(/[,;:]$/, "");
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

/**
 * Puts each label on a straight run of its own wire, and drops the ones that
 * would still collide.
 *
 * The previous version used the geometric midpoint, which on a routed
 * orthogonal path is often a corner — and twice landed outside the leftmost
 * box entirely, floating in empty canvas attached to nothing. A label belongs
 * on a segment you can see it lying along.
 *
 * When two still overlap the lower-weight one is dropped rather than shrunk or
 * nudged: an unreadable label helps nobody, and the wire it names is still
 * there to click.
 */
function placeLabels(edges: LaidEdge[], nodes: LaidNode[]): LaidEdge[] {
  const left = Math.min(...nodes.map((n) => n.x), 0);
  const placed: Array<{ x: number; y: number; w: number }> = [];
  return [...edges]
    // Heavier wires get first claim on the space they need.
    .sort((a, b) => b.weight - a.weight)
    .map((edge) => {
      if (!edge.what) return edge;
      // The longest straight run, so the text lies along the wire rather than
      // across a corner.
      let best: { x: number; y: number; len: number } | null = null;
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = edge.points[i]!, b = edge.points[i + 1]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || len > best.len) best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, len };
      }
      if (!best) return edge;
      const short = shortLabel(edge.what);
      const width = measure(short, 13);
      // A label outside the drawing is attached to nothing as far as a reader
      // is concerned.
      if (best.x - width / 2 < left) return edge;
      // Generous margins: two labels that merely miss each other still read as
      // one smear at a glance, which is the complaint this is fixing.
      const clash = placed.some((p) =>
        Math.abs(p.x - best!.x) < (p.w + width) / 2 + 22 && Math.abs(p.y - best!.y) < 26);
      if (clash) return edge;
      placed.push({ x: best.x, y: best.y, w: width });
      return { ...edge, short, label: { x: best.x, y: best.y } };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface Diagram {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

/**
 * Text is measured, not guessed.
 *
 * ELK does no text measurement, so a box sized by guesswork puts its label
 * outside itself and we are back to overlapping text with a nicer layout
 * underneath. Measuring here means the label's real footprint is reserved
 * during layout, which makes overlap structurally impossible rather than
 * something to fix afterwards.
 *
 * An approximation is fine — this is a monospace-ish average over the UI's
 * sans stack, and the box is padded — but it has to scale with the string.
 */
function measure(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    // Rough per-character advance: wide letters, digits, then narrow ones.
    w += /[mwMW@]/.test(ch) ? size * 0.92
      : /[iljt.,;:'`!|]/.test(ch) ? size * 0.32
        : /[A-Z0-9]/.test(ch) ? size * 0.64
          : size * 0.55;
  }
  return w;
}

/** Wraps to a width, so a long purpose line becomes a known number of lines. */
function wrap(text: string, width: number, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The sizes a node's text is drawn at. These must match `.fnode-title`,
 * `.fnode-does` and `.fnode-badge` in ui.css, and a test reads that file to
 * hold them together.
 *
 * They used to live in two places. The CSS was raised to 14px for legibility
 * and the layout kept measuring at 13, so every box was sized for text smaller
 * than the text it held: the badge row ran out past the right edge and the
 * description was cut mid-sentence with nothing to say it had been.
 */
export const NODE_TEXT = { title: 17, body: 14, badge: 14 } as const;
const PAD = 18;
/** Where the title starts, after the layer icon. */
const TITLE_X = 44;
/** Room the stale warning takes at the right of the title row. */
const WARN_W = 38;
const BODY_LINE = 20;
const MIN_W = 220;
const MAX_W = 340;
/** Three lines of purpose is a summary; five is a paragraph nobody reads on a box. */
const MAX_LINES = 3;

export interface BadgePart { text: string; lost?: boolean }

/** Bold text sets wider than the advance table, which is for regular weight. */
const measureBold = (text: string, size: number) => measure(text, size) * 1.07;

/** Cut to fit a width, ending in an ellipsis so a cut never reads as whole. */
function fit(text: string, width: number, size: number, bold = false): string {
  const m = bold ? measureBold : measure;
  if (m(text, size) <= width) return text;
  let out = text;
  while (out.length > 1 && m(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/**
 * Sizes one box around every string it will show, and hands those strings back.
 *
 * The renderer draws exactly these. It used to re-wrap the description itself,
 * at its own idea of the font size, which is how the box and its text came to
 * disagree.
 *
 * Width is the widest of the title row and the badge row, clamped so one long
 * name cannot stretch a column. When the badge still will not fit, it sheds
 * its least useful part — line count first — rather than overflow.
 */
function box(map: PartMap, counts: { files: number; lines: number; attempts: number; abandoned: number }, stale: boolean) {
  const badge: BadgePart[] = [
    { text: `${counts.files} file${counts.files === 1 ? "" : "s"}` },
    ...(counts.lines ? [{ text: `${counts.lines.toLocaleString("en-US")} lines` }] : []),
    ...(counts.attempts ? [{ text: `${counts.attempts} attempt${counts.attempts === 1 ? "" : "s"}` }] : []),
    ...(counts.abandoned ? [{ text: `${counts.abandoned} abandoned`, lost: true }] : []),
  ];
  const badgeWidth = (parts: BadgePart[]) => measure(parts.map((p) => p.text).join("  ·  "), NODE_TEXT.badge);

  const titleNeed = TITLE_X + measureBold(map.part, NODE_TEXT.title) + (stale ? WARN_W : PAD);
  const w = Math.round(Math.max(MIN_W, Math.min(MAX_W, Math.max(titleNeed, PAD * 2 + badgeWidth(badge)))));

  // Shed badge parts until the row fits, least useful first. "Abandoned" is
  // the one a reader is looking for, so it goes last. The list is walked in
  // its own order: scanning the badge instead found "N files" before "N lines"
  // every time, because the file count comes first in the row.
  for (const word of ["lines", "file", "attempt"]) {
    if (badge.length <= 1 || PAD * 2 + badgeWidth(badge) <= w) break;
    const i = badge.findIndex((p) => p.text.includes(word) && !p.lost);
    if (i >= 0) badge.splice(i, 1);
  }

  const title = fit(map.part, w - TITLE_X - (stale ? WARN_W : PAD), NODE_TEXT.title, true);

  const inner = w - PAD * 2;
  const all = wrap(map.does, inner, NODE_TEXT.body);
  const text = all.slice(0, MAX_LINES);
  if (all.length > MAX_LINES) {
    // The last line ends in an ellipsis, so a reader knows there is more in the
    // panel rather than taking the cut for the whole thought.
    // Whole words only: "Ingest pro…" reads as a typo, "Ingest…" as a cut.
    const words = text[MAX_LINES - 1]!.split(" ");
    while (words.length > 1 && measure(`${words.join(" ")}…`, NODE_TEXT.body) > inner) words.pop();
    while (words.length > 1 && /^(the|a|an|and|or|to|of|in|on|for|with|what|is|no)$/i.test(words.at(-1)!)) words.pop();
    text[MAX_LINES - 1] = `${words.join(" ").replace(/[,;:.]$/, "")}…`;
  }

  // Title baseline 31, description from 54, badge 15 above the bottom edge.
  const lastBody = text.length ? 54 + (text.length - 1) * BODY_LINE : 31;
  const h = lastBody + 26 + 15;
  return { w, h, title, text, badge };
}

/**
 * Which files a part owns, of those that records actually touched.
 *
 * A prefix ending in `/` claims a directory. Exact matches win over prefixes,
 * so a file named by one part is not also claimed by a broader one.
 */
function ownedFiles(map: PartMap, all: string[]): string[] {
  const owns = map.owns ?? [];
  if (!owns.length) return [];
  return all.filter((path) => owns.some((claim) => claims(path, claim)));
}

/** A claim ending in `/` covers everything under that directory; any other names one file. */
const claims = (path: string, claim: string) => (claim.endsWith("/") ? path.startsWith(claim) : path === claim);

/**
 * Which part a file belongs to, or null when nobody has claimed it.
 *
 * The longest claim wins, so `server/ui/` beats `server/` for a file under
 * both. Without that rule a broad claim silently swallows a narrow one and the
 * diagram attributes work to the wrong box.
 */
function ownerOf(path: string, maps: PartMap[]): string | null {
  let best: { part: string; length: number } | null = null;
  for (const map of maps) {
    for (const claim of map.owns ?? []) {
      if (claims(path, claim) && (!best || claim.length > best.length)) best = { part: map.part, length: claim.length };
    }
  }
  return best?.part ?? null;
}

/**
 * Whether some chain of dependencies runs through more than `limit` parts,
 * which is what decides whether the diagram needs to wrap. Cycles are common
 * here — two parts can legitimately feed each other — so the walk carries its
 * own visited set rather than assuming a DAG.
 *
 * The walk stops at the first chain long enough and never goes deeper than
 * that, so its work is bounded by parts × fan-out^limit. It used to measure
 * the longest chain exactly, which enumerates every simple path: exponential
 * on a dense cyclic map, on every /api/map request.
 */
export function chainLongerThan(limit: number, nodes: string[], edges: Array<{ from: string; to: string }>): boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const walk = (at: string, seen: Set<string>): boolean => {
    if (seen.size > limit) return true;
    for (const to of next.get(at) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      if (walk(to, seen)) return true;
      seen.delete(to);
    }
    return false;
  };
  return nodes.some((node) => walk(node, new Set([node])));
}

/**
 * The architecture diagram: the parts an agent described, wired by the imports
 * that actually exist between their files.
 *
 * Both halves matter and neither is sufficient. The boxes are authored, because
 * only a person or an agent can say that a group of files is "the record
 * format" and what it is for. The wires are derived, because an import has one
 * true direction and a hand-written dependency does not — measured here, the
 * authored edges disagreed about direction often enough to force three wires
 * with six to eight bends looping around the outside of the diagram.
 *
 * So: authored meaning, derived structure, and where an authored relation
 * matches a real import, the agent's words become the label on it.
 */
export async function diagram(graph: Graph, code: Structure): Promise<Diagram> {
  const maps = graph.maps;
  if (!maps.length) return { nodes: [], edges: [], width: 0, height: 0 };

  const known = new Map(maps.map((m) => [m.part, m]));
  const byPath = new Map(code.files.map((f) => [f.path, f]));

  // Every file a part owns, from the code rather than from what work touched.
  // This is the whole correction: `protocol` owns eight files because the
  // directory holds eight, not one because one attempt happened to edit one.
  // With them, what was tried there; the box and the node both read this.
  const paths = code.files.map((f) => f.path);
  const facts = new Map(maps.map((map) => {
    const owned: SourceFile[] = ownedFiles(map, paths).map((p) => byPath.get(p)!).filter(Boolean);
    const mine = new Set(owned.map((f) => f.path));
    const touched = graph.records.filter((record) => record.files.some((f) => mine.has(f)));
    return [map.part, {
      owned,
      lines: owned.reduce((n, f) => n + f.lines, 0),
      attempts: touched.length,
      abandoned: touched.filter((record) => record.status === "abandoned").length,
    }];
  }));

  const sized = new Map(maps.map((m) => {
    const f = facts.get(m.part)!;
    return [m.part, box(m, { files: f.owned.length, lines: f.lines, attempts: f.attempts, abandoned: f.abandoned }, Boolean(m.stale))];
  }));

  /**
   * Wires from real imports, collapsed to the parts that own each end.
   *
   * Weight is how many files cross, which is a fact rather than an opinion, and
   * an import inside one part is not a dependency between parts.
   */
  const weights = new Map<string, number>();
  for (const file of code.files) {
    const from = ownerOf(file.path, maps);
    if (!from) continue;
    for (const target of file.imports) {
      const to = ownerOf(target, maps);
      if (!to || to === from) continue;
      const key = `${from}\u0000${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }

  /**
   * The agent's own words for a relation, when one describes a wire that
   * actually exists.
   *
   * Direction comes from the import; only the wording comes from the map. A
   * `reads` entry describes the same wire from the far end, so it is looked up
   * reversed.
   */
  const said = new Map<string, string>();
  for (const map of maps) {
    for (const f of map.feeds ?? []) if (known.has(f.part)) said.set(`${map.part}\u0000${f.part}`, f.what);
    for (const r of map.reads ?? []) if (known.has(r.part)) said.set(`${r.part}\u0000${map.part}`, r.what);
  }

  const wires = [...weights].map(([key, weight]) => {
    const [from, to] = key.split("\u0000");
    return { key, from: from!, to: to!, weight, what: said.get(key) ?? "" };
  });

  /**
   * A described dependency with no import behind it is still drawn, unbacked —
   * unless the same pair already has a real import the other way.
   *
   * Two parts can genuinely relate without importing: through a file on disk, a
   * git ref, a hook the runtime calls. Dropping those would make the diagram
   * claim the system is smaller than it is.
   *
   * But an agent describing "A feeds B" when the import runs B to A is not a
   * second relationship, it is the same one seen from the other end — and
   * drawing both produced five contradictory pairs here and forced wires with
   * eight bends looping around the diagram. The import decides the direction;
   * the sentence becomes that wire's label.
   */
  for (const [key, what] of said) {
    if (weights.has(key)) continue;
    const [from, to] = key.split("\u0000");
    const reverse = `${to}\u0000${from}`;
    if (weights.has(reverse)) {
      const existing = wires.find((w) => w.key === reverse);
      if (existing && !existing.what) existing.what = what;
      continue;
    }
    wires.push({ key, from: from!, to: to!, weight: 0, what });
  }

  const wrapping = chainLongerThan(5, maps.map((m) => m.part), wires)
    ? { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": "1.8" }
    : {};

  const laid = await elk.layout({
    id: "root",
    layoutOptions: {
      ...wrapping,
      "elk.algorithm": "layered",
      // Left to right, because a dependency reads like a sentence and screens
      // are wider than they are tall.
      "elk.direction": "RIGHT",
      // Wires as wires: right angles around boxes, never diagonals through them.
      "elk.edgeRouting": "ORTHOGONAL",
      // A real system has cycles and pretending otherwise produces the long
      // loops this replaces. Greedy breaks the fewest edges to rank the rest.
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      // Roomy on purpose. The gap between columns is where wire labels live, so
      // a tight diagram is one where the labels have nowhere to go and end up
      // on top of each other.
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      "elk.spacing.nodeNode": "54",
      "elk.spacing.edgeNode": "30",
      "elk.spacing.edgeEdge": "20",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
    },
    children: maps.map((m) => {
      const s = sized.get(m.part)!;
      return { id: m.part, width: s.w, height: s.h };
    }),
    edges: wires.map((w, i) => ({
      id: `e${i}`,
      sources: [w.from],
      targets: [w.to],
      labels: [{ text: w.what, id: w.key }],
    })),
  } as never) as ElkResult;

  const nodes: LaidNode[] = (laid.children ?? []).map((c) => {
    const map = known.get(c.id)!;
    const f = facts.get(c.id)!;
    return {
      id: c.id,
      label: c.id,
      does: map.does,
      layer: map.layer ?? "core",
      x: c.x ?? 0,
      y: c.y ?? 0,
      w: c.width ?? MIN_W,
      h: c.height ?? 80,
      attempts: f.attempts,
      abandoned: f.abandoned,
      files: f.owned.map((file) => file.path),
      lines: f.lines,
      stale: Boolean(map.stale),
      title: sized.get(c.id)!.title,
      text: sized.get(c.id)!.text,
      badge: sized.get(c.id)!.badge,
    };
  });

  const byId = new Map(wires.map((w, i) => [`e${i}`, w]));
  const edges: LaidEdge[] = (laid.edges ?? []).flatMap((e) => {
    const section = e.sections?.[0];
    if (!section) return [];
    const wire = byId.get(e.id);
    return [{
      id: e.id,
      from: e.sources[0] ?? "",
      to: e.targets[0] ?? "",
      what: wire?.what ?? "",
      weight: wire?.weight ?? 0,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    }];
  });

  return { nodes, edges: placeLabels(edges, nodes), width: laid.width ?? 0, height: laid.height ?? 0 };
}
