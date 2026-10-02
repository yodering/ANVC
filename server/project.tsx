/**
 * What you see when you open a project, one tab at a time: what's happening
 * now, what the project is for, how its text is written, and which tools its
 * agents have. Each tab's name says what it holds, so nothing explains it.
 * The tab chosen last is kept in this browser.
 */
import { useState } from "preact/hooks";
import { Goals } from "./goals";
import { ProjectMap } from "./map";
import { Rules } from "./rules";
import { Status } from "./status";
import { Tools } from "./tools";
import { Hint } from "./widgets";

type Tab = "map" | "status" | "goals" | "rules" | "tools";
const TABS: Array<[Tab, string]> = [["map", "Map"], ["status", "Status"], ["goals", "Goals"], ["rules", "Writing rules"], ["tools", "Tools"]];
const saved = (): Tab => {
  try { const t = localStorage.getItem("anvc.project.tab"); return TABS.some(([id]) => id === t) ? t as Tab : "map"; } catch { return "map"; }
};

export function ProjectPage() {
  const [tab, setTab] = useState<Tab>(saved);
  const pick = (t: Tab) => { setTab(t); try { localStorage.setItem("anvc.project.tab", t); } catch { /* fine */ } };
  return (
    <div class="project-page">
      <div class="filterbar">
        <div class="filter-tabs" role="tablist" aria-label="Project">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} class={tab === id ? "current" : ""} onClick={() => pick(id)}>{label}</button>
          ))}
        </div>
        <span class="project-info"><Hint id={`project-${tab}`} /></span>
      </div>
      <div class="project-panel" role="tabpanel">
        {tab === "map" && <ProjectMap />}
        {tab === "status" && <Status />}
        {tab === "goals" && <Goals />}
        {tab === "rules" && <Rules />}
        {tab === "tools" && <Tools />}
      </div>
    </div>
  );
}
