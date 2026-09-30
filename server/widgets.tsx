import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { HINTS } from "./glossary";
import type { TurnAction } from "./api";
export type Action = TurnAction;

/** A write to the server. The header is what the server checks to refuse writes from any other page. */
export const send = (path: string, body: unknown, method = "POST") =>
  fetch(path, { method, headers: { "content-type": "application/json", "x-anvc": "1" }, body: JSON.stringify(body) });

/** The server answers every route with JSON, errors included, so this never checks the status. */
export const getJson = <T = any>(path: string, init?: RequestInit): Promise<T> => fetch(path, init).then((r) => r.json());

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "29 Sep, 14:02": several changes a day is normal, so the time is shown too. */
export const when = (ts: string) => new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export type Save<C> = (change: C) => Promise<boolean>;

/**
 * What a route answers, read again every ten seconds, since agents change it
 * mid-session, and a save that posts a change and shows the answer.
 */
export function useLive<T, C = object>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => void getJson<T & { error?: string }>(path).then((v) => !v.error && setData(v)).catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [path]);
  const save: Save<C> = async (change) => {
    try {
      const r = await send(path, change);
      const out = (await r.json()) as T & { error?: string };
      if (!r.ok || out.error) { setError(out.error ?? "Couldn't save."); return false; }
      setError("");
      setData(out);
      return true;
    } catch {
      setError("Can't reach ANVC.");
      return false;
    }
  };
  return { data, error, save };
}

/** A one-line title to add or change, with Cancel. Anything else the form asks for goes in `children`. */
export function TitleForm({ label, placeholder = label, submit, initial = "", changed = false, onSave, onCancel, children }: {
  label: string; placeholder?: string; submit: string; initial?: string;
  /** Whether something besides the title changed, so saving is worth it with the same title. */
  changed?: boolean;
  onSave: (title: string) => void; onCancel: () => void; children?: ComponentChildren;
}) {
  const [title, setTitle] = useState(initial);
  return (
    <form class="title-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSave(title.trim()); }}>
      <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} aria-label={label} placeholder={placeholder} maxLength={200} autoFocus />
      {children}
      <button type="submit" class="button primary" disabled={!title.trim() || (title.trim() === initial && !changed)}>{submit}</button>
      <button type="button" class="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}

/**
 * A native modal. The browser keeps focus inside it, closes it on Escape and
 * puts focus back where it was when it closes; a click on the backdrop closes
 * it too. It stays mounted while closed, because only closing it, not removing
 * it, returns focus.
 */
export function Modal({ open, onClose, children, ...attrs }: {
  open: boolean; onClose: () => void; children: ComponentChildren;
} & Omit<JSX.HTMLAttributes<HTMLDialogElement>, "open" | "onClose">) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open) dialog.close();
  }, [open]);
  return (
    <dialog
      {...attrs}
      ref={ref}
      // Escape and the backdrop close the dialog first; this tells the owner.
      onClose={() => { if (open) onClose(); }}
      onClick={(event) => {
        // The backdrop is the dialog itself, outside its box. A click on the
        // dialog's own padding has the same target, so the position decides.
        const box = ref.current!.getBoundingClientRect();
        const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        if (event.target === ref.current && outside) ref.current!.close();
      }}
    >
      {children}
    </dialog>
  );
}

export function OutcomeBadge({ status }: { status: string }) {
  const lost = status === "abandoned";
  return (
    <span class={`outcome ${lost ? "abandoned" : "kept"}`}>
      <Icon name={lost ? "circle-x" : "circle-check"} size={13} />
      {lost ? "Abandoned" : "Kept"}
    </span>
  );
}

export function Source({ authored }: { authored: boolean }) {
  return (
    <span
      class="source"
      title={
        authored
          ? "The agent stated this goal"
          : "Rebuilt from the session. The agent didn't state a goal."
      }
    >
      {authored ? "Agent-written" : "Captured"}
    </span>
  );
}

export function Track({
  actions,
  seconds,
}: {
  actions: Action[];
  seconds: number;
}) {
  return (
    <div
      class="track"
      aria-label={`${actions.length} recorded steps over ${seconds} seconds`}
    >
      {actions.map((action, i) => (
        <span
          key={i}
          class={`seg ${action.kind}`}
          style={{
            left: `${Math.max(0, Math.min(100, (action.at / Math.max(seconds, 1)) * 100))}%`,
          }}
          title={`${action.at}s · ${action.kind === "shell" ? "command" : action.kind} · ${action.label}`}
        />
      ))}
    </div>
  );
}

export function Field({
  title,
  hint,
  children,
}: {
  title: string;
  /** A glossary key, when the heading uses a word this project invented. */
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <section class="detail-section">
      <h3>{hint ? <Hint id={hint}>{title}</Hint> : title}</h3>
      {children}
    </section>
  );
}

/**
 * A term with its explanation one hover away.
 *
 * Words like anchor, captured and recheck command were invented by this
 * project, and a reader has no way to guess them.
 *
 * Built rather than using `title=`: the native tooltip takes about a second to
 * appear, cannot be styled to stay readable on this surface, and never shows
 * on a keyboard focus. This one appears immediately, on hover or focus, and
 * the marker is a real button so it is reachable by tab.
 */
export function Hint({ id, children }: { id: string; children?: ComponentChildren }) {
  const hint = HINTS[id];
  if (!hint) return <>{children}</>;
  return (
    <span class="hint">
      {children}
      <button
        class="hint-mark"
        type="button"
        aria-label={`What does ${hint.term} mean?`}
        // The panel is presentational; the label above already carries the
        // question, and the text is readable by focusing the button.
        onClick={(event) => event.stopPropagation()}
      >
        <Icon name="circle-help" size={12} />
      </button>
      <span class="hint-panel" role="tooltip">
        <b>{hint.term}</b>
        <span>{hint.what}</span>
        {hint.why && <span class="hint-why">{hint.why}</span>}
      </span>
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string;
}) {
  return (
    <div class="choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v}
          class={`choice-${v}${value === v ? " is-on" : ""}`} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

type Where = "project" | "everywhere";

/** Which projects a setting applies to, and the way back to the one for every project. */
export function Scope({ scope, own, onScope, onFollow }: {
  scope: Where; own: boolean; onScope: (scope: Where) => void; onFollow: () => void;
}) {
  return (
    <>
      <div class="scope">
        <Segmented label="Applies to" value={scope} onChange={onScope}
          options={[["everywhere", "Every project"], ["project", "This project"]]} />
      </div>
      {scope === "project" && (own ? (
        <p class="settings-sub">
          This project has its own choice.{" "}
          <button type="button" class="link-button" onClick={onFollow}>Use the one for every project</button>
        </p>
      ) : (
        <p class="settings-sub">This project follows your choice for every project until you change something here.</p>
      ))}
    </>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState("Copy");
  useEffect(() => {
    if (state === "Copy") return;
    const timer = setTimeout(() => setState("Copy"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      class="copy-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("Copied");
        } catch {
          setState("Select to copy");
        }
      }}
    >
      <Icon name="copy" size={14} />
      <span aria-live="polite">{state}</span>
    </button>
  );
}

/** A command on its own line, with a button that copies it. */
export const Copy = ({ text }: { text: string }) => (
  <div class="copy-block"><code>{text}</code><CopyButton text={text} /></div>
);
