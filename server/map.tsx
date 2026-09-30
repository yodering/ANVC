/**
 * The project, drawn.
 *
 * One view: the parts an agent described, wired by the imports between their
 * files, ranked into columns. A second view hung files off each part as a tree;
 * it showed nothing the part's panel does not, and was removed.
 *
 * What the first attempt got wrong, and what this fixes. It drew sixty file
 * nodes positioned by a force simulation, which is a picture of file churn
 * rather than of a system, and at ten-pixel labels it was unreadable. Nodes
 * here are the things a person would say out loud, layout is computed by ELK
 * on the server, and nothing is set below fourteen pixels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Diagram, LaidNode } from "./layout";
import type { mapView } from "./api";
import { Field, getJson, Icon, plural } from "./widgets";

type MapPayload = Awaited<ReturnType<typeof mapView>>;

/**
 * The kinds of part on the map. Each has an icon, a name and a colour, and the
 * colour does the work at a glance: with the icon alone, a dozen grey boxes
 * read as one grid. The hues live in ui.css as --layer-* tokens, chosen to stay
 * clear of amber (selection) and of green and red (kept and abandoned).
 */
const LAYER: Record<string, { name: string; icon: string; what: string }> = {
  edge: {
    name: "Entry points", icon: "plug",
    what: "Where work comes in: agent sessions and editor hooks.",
  },
  tool: {
    name: "Tools", icon: "wrench",
    what: "Run by an agent or a person when needed.",
  },
  core: {
    name: "Core logic", icon: "cpu",
    what: "The rules for records and queries.",
  },
  store: {
    name: "Storage", icon: "database",
    what: "Where records are kept.",
  },
  surface: {
    name: "Screens", icon: "monitor",
    what: "What people look at.",
  },
};
const iconOf = (layer: string) => LAYER[layer]?.icon ?? LAYER.core!.icon;
/** Sets `--hue` to the layer's colour; the stylesheet decides where it shows. */
const hueOf = (layer: string) => ({ "--hue": `var(--layer-${LAYER[layer] ? layer : "core"})` });

/**
 * A path through ELK's routed bend points, with the corners rounded.
 *
 * Square corners make a diagram look like a circuit board; rounded ones make
 * the same geometry read as wiring. The radius is clamped to half the shorter
 * adjacent segment so a tight elbow never overshoots into the next one.
 */
function wire(points: Array<{ x: number; y: number }>, radius = 10): string {
  if (points.length < 2) return "";
  if (points.length === 2) return `M${points[0]!.x} ${points[0]!.y}L${points[1]!.x} ${points[1]!.y}`;
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!, at = points[i]!, next = points[i + 1]!;
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - at.x, next.y - at.y) || 1;
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const from = { x: at.x - ((at.x - prev.x) / inLen) * r, y: at.y - ((at.y - prev.y) / inLen) * r };
    const to = { x: at.x + ((next.x - at.x) / outLen) * r, y: at.y + ((next.y - at.y) / outLen) * r };
    d += `L${from.x} ${from.y}Q${at.x} ${at.y} ${to.x} ${to.y}`;
  }
  const last = points.at(-1)!;
  return `${d}L${last.x} ${last.y}`;
}

/* ------------------------------------------------------------------ canvas */

/**
 * Pan and zoom over a laid-out drawing.
 *
 * Hand-rolled rather than adding d3-zoom: this needs wheel, drag and a fit
 * button, which is thirty lines against a dependency. The scale also drives
 * the level of detail below, so it has to be state this component owns.
 */
function useCanvas(width: number, height: number) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !width || !height) return;
    const pad = 56;
    const k = Math.min((el.clientWidth - pad) / width, (el.clientHeight - pad) / height, 1.2);
    setView({ k, x: (el.clientWidth - width * k) / 2, y: (el.clientHeight - height * k) / 2 });
  }, [width, height]);

  // Fit when the drawing changes, on the next frame so the box has been sized.
  useEffect(() => {
    const id = requestAnimationFrame(fit);
    const onResize = () => fit();
    addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(id); removeEventListener("resize", onResize); };
  }, [fit]);

  // Zoom about a point in the box: whatever is under it must stay there.
  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const k = Math.min(2.4, Math.max(0.25, v.k * factor));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  const zoomAtPointer = (event: MouseEvent, factor: number) => {
    event.preventDefault();
    const rect = box.current?.getBoundingClientRect();
    if (rect) zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
  };
  const onWheel = (event: WheelEvent) => zoomAtPointer(event, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    // A mousedown left alone starts a text selection, so a drag meant to pan
    // painted a selection across the canvas and its labels.
    event.preventDefault();
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    setDragging(true);
  };
  const onMove = (event: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (event.clientX - d.x), y: d.vy + (event.clientY - d.y) }));
  };
  const stop = () => { drag.current = null; setDragging(false); };
  // Double-click zooms in about the point clicked, as it does on every map and
  // design canvas. Before this it did nothing but select text.
  const onDouble = (event: MouseEvent) => zoomAtPointer(event, 1.6);
  // The buttons zoom about the middle of the box.
  const zoom = (factor: number) => zoomAt((box.current?.clientWidth ?? 0) / 2, (box.current?.clientHeight ?? 0) / 2, factor);

  return { box, view, fit, zoom, onWheel, onDown, onMove, onDouble, stop, dragging };
}

/* ------------------------------------------------------------------- flow */

function FlowNode({ node, focus, dim, onPick }: {
  node: LaidNode; focus: boolean; dim: boolean; onPick: (id: string) => void;
}) {
  return (
    <g
      class={`fnode${dim ? " is-dim" : ""}${focus ? " is-focus" : ""}`}
      transform={`translate(${node.x} ${node.y})`}
      onClick={(e) => { e.stopPropagation(); onPick(node.id); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(node.id); } }}
      aria-label={`${node.label}. ${node.does}`}
      style={hueOf(node.layer)}
    >
      <rect class="fnode-lift" x="1" y="5" width={node.w} height={node.h} rx="13" />
      <rect class="fnode-body" width={node.w} height={node.h} rx="13" />
      {/* The outline and the icon both say what kind of part this is. Colour
          alone fails a colourblind reader; the icon's shape survives that. */}
      <g class="fnode-icon" transform="translate(19 18)">
        <Icon name={iconOf(node.layer)} size={17} />
      </g>
      <text class="fnode-title" x="44" y="31">{node.title}</text>
      {node.stale && (
        <g class="fnode-stale" transform={`translate(${node.w - 34} 18)`}>
          <title>Description is older than the code</title>
          <Icon name="triangle-alert" size={16} />
        </g>
      )}
      {node.text.map((line, i) => (
        <text class="fnode-does" key={i} x="19" y={54 + i * 20}>{line}</text>
      ))}
      <text class="fnode-badge" x="19" y={node.h - 15}>
        {node.badge.map((part, i) => (
          <tspan key={part.text} class={part.lost ? "is-lost" : undefined}>
            {i > 0 ? `  ·  ${part.text}` : part.text}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** The pannable drawing, its zoom controls and its key. */
function Flow({ data, picked, onPick }: {
  data: Diagram; picked: string | null; onPick: (id: string) => void;
}) {
  const canvas = useCanvas(data.width, data.height);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? picked;
  // The focused node plus everything one hop away; the rest is dimmed.
  const near = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const e of data.edges) {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    }
    return set;
  }, [focus, data.edges]);
  const { view } = canvas;
  // Edge labels are only legible above a certain scale, and drawing them below
  // it is exactly what turns a diagram into mush. Detail is tied to zoom, not
  // to taste — the same trick that keeps Obsidian's graph readable.
  const showLabels = view.k > 0.7;

  return (
    <div class="canvas-wrap">
      <div
        class={`canvas${canvas.dragging ? " is-dragging" : ""}`}
        ref={canvas.box}
        onWheel={canvas.onWheel}
        onMouseDown={canvas.onDown}
        onDblClick={canvas.onDouble}
        onMouseMove={canvas.onMove}
        onMouseUp={canvas.stop}
        onMouseLeave={canvas.stop}
        onClick={() => onPick("")}
      >
        <svg width="100%" height="100%" role="img" aria-label="System parts and their dependencies">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--line-strong)" />
              </marker>
              <marker id="arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
              </marker>
            </defs>
            {data.edges.map((e) => {
              const on = Boolean(near && near.has(e.from) && near.has(e.to));
              const off = Boolean(near && !on);
              // Two or three words, chosen server-side so the layout reserved room
              // for exactly this string. The sentence lives in the panel.
              const text = e.short ?? "";
              return (
                <g key={e.id} class={`fedge${off ? " is-dim" : ""}${on ? " is-on" : ""}${e.weight === 0 ? " is-unbacked" : ""}`}>
                  <path
                    d={wire(e.points)}
                    fill="none"
                    // Thicker where more files cross, so weight reads without a number.
                    stroke-width={e.weight > 0 ? Math.min(3.4, 1.4 + e.weight * 0.35) : 1.4}
                    marker-end={on ? "url(#arrow-on)" : "url(#arrow)"}
                  >
                    <title>
                      {e.weight > 0
                        ? `${plural(e.weight, "file")} in ${e.from} import from ${e.to}`
                        : `${e.from} depends on ${e.to}, described but with no import behind it`}
                    </title>
                  </path>
                  {/* Placed on the longest straight run of this wire, server-side,
                      rather than at the geometric midpoint — which on a routed path
                      is often a corner, and twice landed outside the drawing. */}
                  {showLabels && text && e.label && (
                    <>
                      {/* A plate behind the label so a wire never runs through the
                          words; cheaper and more reliable than routing around text. */}
                      <text class="fedge-plate" x={e.label.x} y={e.label.y - 11} text-anchor="middle">{text}</text>
                      <text class="fedge-label" x={e.label.x} y={e.label.y - 11} text-anchor="middle">{text}</text>
                    </>
                  )}
                </g>
              );
            })}
            {data.nodes.map((n) => (
              <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                <FlowNode node={n} focus={focus === n.id} dim={Boolean(near && !near.has(n.id))} onPick={onPick} />
              </g>
            ))}
          </g>
        </svg>
      </div>
      <div class="canvas-controls">
        <button type="button" onClick={() => canvas.zoom(1.25)} aria-label="Zoom in">
          <Icon name="plus" size={17} />
        </button>
        <button type="button" onClick={() => canvas.zoom(1 / 1.25)} aria-label="Zoom out">
          <Icon name="minus" size={17} />
        </button>
        <button type="button" class="is-wide" onClick={canvas.fit}>Fit</button>
      </div>
      <Legend />
    </div>
  );
}

/**
 * What the colours, icons and line styles mean.
 *
 * Previously a row of eleven-pixel text along the bottom edge, which is where
 * a key goes when nobody expects it to be read. A diagram whose vocabulary is
 * unexplained is one a newcomer has to guess at, and guessing is the thing
 * this whole view exists to remove — so it opens as a panel, at a size meant
 * for reading.
 */
function Legend() {
  return (
    <details class="legend">
      <summary class="legend-toggle">
        <Icon name="circle-help" size={16} />
        <span>Legend</span>
      </summary>
      <div class="legend-body">
        <h4>Parts</h4>
        <ul class="legend-kinds">
          {Object.entries(LAYER).map(([key, v]) => (
            <li key={key}>
              <span class="legend-chip" style={hueOf(key)}>
                <Icon name={v.icon} size={17} />
              </span>
              <span>
                <b>{v.name}</b>
                <span>{v.what}</span>
              </span>
            </li>
          ))}
        </ul>
        <h4>Wires</h4>
        <ul class="legend-marks">
          <li>
            <svg width="42" height="14" aria-hidden="true"><line x1="2" y1="7" x2="40" y2="7" stroke="var(--line-strong)" stroke-width="3" /></svg>
            <span><b>Thicker</b> · more imports</span>
          </li>
          <li>
            <svg width="42" height="14" aria-hidden="true"><line x1="2" y1="7" x2="40" y2="7" stroke="var(--line-strong)" stroke-width="1.4" stroke-dasharray="6 5" /></svg>
            <span><b>Dashed</b> · described, but nothing imports it</span>
          </li>
          <li>
            <span class="legend-warn"><Icon name="triangle-alert" size={16} /></span>
            <span><b>Warning</b> · the description is older than the code</span>
          </li>
        </ul>
        <p class="legend-foot">Drag to pan · scroll to zoom · click a part</p>
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------- overview */

/**
 * How the whole thing fits together, without clicking eight boxes.
 *
 * The diagram shows every relation but makes a reader assemble the story from
 * it. This states the story: what enters the system, what holds the logic,
 * where things are kept, what a person looks at — grouped by layer, in reading
 * order, with each part's own sentence beside it.
 *
 * Derived rather than written, so it cannot drift from the diagram it
 * summarises. There is no second description to keep in step.
 */
function Overview({ payload, onPick, onClose }: {
  payload: MapPayload; onPick: (id: string) => void; onClose: () => void;
}) {
  const order = ["edge", "tool", "core", "store", "surface"] as const;
  const byLayer = order
    .map((layer) => ({ layer, parts: payload.maps.filter((m) => (m.layer ?? "core") === layer) }))
    .filter((group) => group.parts.length > 0);

  const entries = payload.flow.nodes.filter((n) =>
    !payload.flow.edges.some((e) => e.to === n.id)).map((n) => n.id);

  return (
    <aside class="map-detail map-overview" aria-label="Overview">
      <div class="map-detail-head">
        <h3>Overview</h3>
        <button type="button" class="icon-button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={17} />
        </button>
      </div>
      <p class="detail-prose">
        {plural(payload.maps.length, "part")} over {plural(payload.files, "file")}.
        {entries.length > 0 && <> Starts at {entries.slice(0, 3).map((e, i) => <>{i > 0 && ", "}<b>{e}</b></>)}.</>}
      </p>
      {byLayer.map(({ layer, parts }) => (
        <section class="detail-section overview-layer" key={layer}>
          <h3>
            <span class="overview-icon" style={hueOf(layer)}>
              <Icon name={iconOf(layer)} size={15} />
            </span>
            {LAYER[layer]!.name}
          </h3>
          <ul class="map-links">
            {parts.map((m) => (
              <li key={m.part}>
                <button type="button" onClick={() => onPick(m.part)}>
                  {m.part}
                  {m.stale && <Icon name="triangle-alert" size={13} />}
                </button>
                <span>{m.does}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

/* ----------------------------------------------------------------- detail */

function Detail({ part, payload, onClose, onPick }: {
  part: string; payload: MapPayload; onClose: () => void; onPick: (id: string) => void;
}) {
  const map = payload.maps.find((m) => m.part === part);
  const node = payload.flow.nodes.find((n) => n.id === part);

  return (
    <aside class="map-detail" aria-label={part}>
      <div class="map-detail-head">
        <span class="map-detail-layer" style={hueOf(map?.layer ?? node?.layer ?? "core")} />
        <h3>{part}</h3>
        <button type="button" class="icon-button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={17} />
        </button>
      </div>
      {map && <p class="detail-prose">{map.does}</p>}
      {node && (
        <p class="map-detail-sum">
          {plural(node.files.length, "file")}
          {node.lines > 0 && <> · {node.lines.toLocaleString()} lines</>}
          {node.attempts > 0 && <> · {plural(node.attempts, "attempt")}</>}
          {node.abandoned > 0 && <> · <b class="is-lost-text">{node.abandoned} abandoned</b></>}
        </p>
      )}
      {map?.stale && (
        <p class="map-stale-note">
          <Icon name="triangle-alert" size={15} />
          <span>
            Described {map.ts.slice(0, 10)}; code changed {map.code_ts?.slice(0, 10)}.
          </span>
        </p>
      )}
      {map && map.decisions.length > 0 && (
        <Field title="Decisions">
          <ul class="ruled-out">
            {map.decisions.map((d, i) => (
              <li key={i}>
                <span class="ruled-approach">{d.what}</span>
                <span class="ruled-because">{d.because}</span>
              </li>
            ))}
          </ul>
        </Field>
      )}
      {map && map.reads.length > 0 && (
        <Field title="Depends on">
          <ul class="map-links">
            {map.reads.map((r) => (
              <li key={r.part}>
                <button type="button" onClick={() => onPick(r.part)}>{r.part}</button>
                <span>{r.what}</span>
              </li>
            ))}
          </ul>
        </Field>
      )}
      {map && map.feeds.length > 0 && (
        <Field title="Used by">
          <ul class="map-links">
            {map.feeds.map((f) => (
              <li key={f.part}>
                <button type="button" onClick={() => onPick(f.part)}>{f.part}</button>
                <span>{f.what}</span>
              </li>
            ))}
          </ul>
        </Field>
      )}
      {node && node.files.length > 0 && (
        <Field title="Files">
          <ul class="map-files">{node.files.slice(0, 16).map((f) => <li key={f}>{f}</li>)}</ul>
        </Field>
      )}
      {map && map.history.length > 0 && (
        <details>
          <summary class="map-history-toggle">{plural(map.history.length, "earlier version")}</summary>
          <Field title="Earlier version" hint="earlier-version">
            <ul class="ruled-out">
              {map.history.map((h) => (
                <li key={h.id}>
                  <span class="ruled-approach">{h.ts.slice(0, 10)}</span>
                  <span class="ruled-because">{h.does}</span>
                </li>
              ))}
            </ul>
          </Field>
        </details>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ shell */

export function ProjectMap() {
  const [payload, setPayload] = useState<MapPayload | null>(null);
  const [error, setError] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // Open by default: a reader arriving at a project they do not know should be
  // told how it fits together before being asked to click anything.
  const [overview, setOverview] = useState(true);

  useEffect(() => {
    // Fetched once. The shape of a project does not change between two
    // ten-second polls, and a layout that moves under the cursor cannot be
    // clicked.
    void getJson<MapPayload | { error: string }>("/api/map", { signal: AbortSignal.timeout(20000) })
      .then((data) => ("error" in data ? setError(true) : setPayload(data)))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPicked(null); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (error) return <p class="map-empty">Couldn't draw the map.</p>;
  if (!payload) return <p class="map-empty">Drawing the map…</p>;

  const drawn = payload.flow;
  const pick = (id: string) => setPicked(id || null);
  const stale = payload.maps.filter((m) => m.stale).map((m) => m.part);

  return (
    <div class="map">
      {stale.length > 0 && (
        <p class="page-summary is-warn">
          {stale.length === 1
            ? <>The description of <b>{stale[0]}</b> is older than its code.</>
            : <>{stale.length} descriptions are older than their code: {stale.map((p, i) => <>{i > 0 && ", "}<b>{p}</b></>)}.</>}
        </p>
      )}
      {drawn.nodes.length === 0 ? (
        <div class="map-blank">
          <p class="map-blank-head">Nothing mapped yet.</p>
          <p class="detail-prose">Ask your agent to describe how the project fits together.</p>
        </div>
      ) : (
        <div class="map-body">
          <div class="map-main">
            <Flow data={payload.flow} picked={picked} onPick={pick} />
          </div>
          {picked
            ? <Detail part={picked} payload={payload} onClose={() => setPicked(null)} onPick={pick} />
            : overview && <Overview payload={payload} onPick={pick} onClose={() => setOverview(false)} />}
        </div>
      )}
    </div>
  );
}
