/**
 * The tour: what anvc keeps, where it keeps it, and who can read it.
 *
 * Opens by itself the first time, and from the sidebar after that. It exists
 * because the one thing a person must understand before trusting this with
 * real work — that some of it travels with `git push` and some never does —
 * was written down nowhere they would see it.
 *
 * The numbers are this repository's, read from /api/tiers when it opens. A
 * tour about "your private tier" that shows an example's figures is a tour
 * nobody believes.
 */
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { tierFacts } from "../protocol/tiers";
import { anvc, useInstall, type Install } from "./install";
import { getJson, Icon, Modal, plural } from "./widgets";

type Facts = ReturnType<typeof tierFacts>;

const SEEN = "anvc.tour.seen";

export function tourSeen(): boolean {
  try { return localStorage.getItem(SEEN) === "1"; } catch { return true; }
}

interface Step { title: string; body: ComponentChildren; visual: ComponentChildren }

function steps(f: Facts | null, install: Install | null): Step[] {
  const init = install && anvc(install, "init");
  const n = (x: number | undefined) => (f ? (x ?? 0).toLocaleString() : "…");
  return [
    {
      title: "Attempts",
      body: <p>ANVC keeps the attempts your agents gave up on, as well as the ones they committed.</p>,
      visual: null,
    },
    {
      title: "Private and shared",
      body: (
        <p>
          Only shared records are pushed with your code, with paths made relative and your
          prompts removed. Your agent can't share a record; only you can.
        </p>
      ),
      visual: (
        <div class="tour-tiers">
          <div class="tour-tier is-private">
            <header><Icon name="hard-drive" size={20} /><b>Private</b></header>
            <ul>
              <li>{f ? plural(f.private.captured.events, "action") : "…"} in the raw log</li>
              <li>{f ? plural(f.private.transcripts.files, "saved session") : "…"}</li>
              <li>{f ? plural(f.private.records, "record") : "…"}</li>
            </ul>
          </div>
          <div class="tour-arrow" aria-hidden="true">
            <span>anvc share</span>
            <Icon name="arrow-right" size={20} />
          </div>
          <div class="tour-tier is-shared">
            <header><Icon name="git-commit-horizontal" size={20} /><b>Shared</b></header>
            <ul>
              <li>{f ? plural(f.shared.records, "record") : "…"}</li>
              <li>{f ? `${n(f.shared.pushed)} pushed, ${n(f.shared.waiting)} waiting` : "…"}</li>
              <li>{f ? `${n(f.shared.fromTeammates)} from teammates` : "…"}</li>
            </ul>
          </div>
          {f && !f.pushConfigured && init && (
            <p class="tour-warn">
              <Icon name="triangle-alert" size={16} />
              These won't be pushed yet. Run <code>{init}</code>{init.startsWith("/") ? " in Claude Code" : ""} to fix that.
            </p>
          )}
        </div>
      ),
    },
    {
      title: "What an agent reads",
      body: <p>An agent sees one line first, and opens more only if it needs to.</p>,
      visual: (
        <ol class="tour-depth">
          <li><b>One line</b><span>what was abandoned, and why</span></li>
          <li><b>Record</b><span>goal, outcome, files, recheck command</span></li>
          <li><b>Detail</b><span>full output, what was ruled out, what wasn't checked</span></li>
          <li><b>Raw log</b><span>everything, only on this computer</span></li>
        </ol>
      ),
    },
  ];
}

export function Tour({ open, onClose, onChoose }: { open: boolean; onClose: () => void; onChoose: () => void }) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [at, setAt] = useState(0);
  const install = useInstall();
  const list = steps(facts, install);
  const last = at === list.length - 1;

  useEffect(() => {
    if (!open) return;
    setAt(0);
    void getJson<Facts | { error: string }>("/api/tiers", { signal: AbortSignal.timeout(10000) })
      .then((body) => { if (!("error" in body)) setFacts(body); })
      .catch(() => { /* the tour still reads without numbers */ });
  }, [open]);

  const close = () => {
    try { localStorage.setItem(SEEN, "1"); } catch { /* a private window forgets; fine */ }
    onClose();
  };

  // Escape is the dialog's own; the arrow keys move between steps.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setAt((i) => Math.min(list.length - 1, i + 1));
      if (event.key === "ArrowLeft") setAt((i) => Math.max(0, i - 1));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, list.length]);

  const step = list[at]!;

  return (
    <Modal open={open} onClose={close} class="tour" aria-labelledby="tour-title">
      {open && (<>
        <button type="button" class="icon-button" onClick={close} aria-label="Close the tour">
          <Icon name="close" size={18} />
        </button>
        <p class="tour-count">{at + 1} of {list.length}</p>
        {/* Keyed on the step so each one enters fresh rather than morphing. */}
        <div class="tour-step" key={at}>
          <h2 id="tour-title">{step.title}</h2>
          <div class="tour-body">{step.body}</div>
          {step.visual && <div class="tour-visual">{step.visual}</div>}
        </div>
        <footer class="tour-nav">
          <div class="tour-dots" role="tablist" aria-label="Tour steps">
            {list.map((s, i) => (
              <button
                key={s.title}
                type="button"
                role="tab"
                aria-selected={i === at}
                aria-label={`Step ${i + 1}: ${s.title}`}
                class={i === at ? "is-on" : ""}
                onClick={() => setAt(i)}
              />
            ))}
          </div>
          <div class="tour-buttons">
            {at > 0 && <button type="button" class="button" onClick={() => setAt(at - 1)}>Back</button>}
            {last && (
              <button type="button" class="button" onClick={close}>Done</button>
            )}
            <button type="button" class="button primary" onClick={() => {
              if (!last) { setAt(at + 1); return; }
              // The tour ends where the choice it explained is made.
              try { localStorage.setItem(SEEN, "1"); } catch { /* fine */ }
              onChoose();
            }}>
              {last ? "Choose what to save" : "Next"}
              <Icon name="arrow-right" size={16} />
            </button>
          </div>
        </footer>
      </>)}
    </Modal>
  );
}
