/**
 * What anvc did here, at the top of the work log.
 *
 * The page's first answer should be the question a person opening it has:
 * is this doing anything. Four counts, each named for what it proves, never
 * added into one number; "avoided" is marked as an estimate because it is one.
 */
import { useEffect, useState } from "preact/hooks";
import type { Helped } from "../protocol/helped";
import { getJson, Hint, plural } from "./widgets";

export function HelpedBlock() {
  const [data, setData] = useState<Helped | null>(null);
  useEffect(() => {
    void getJson<Helped | { error: string }>("/api/helped", { signal: AbortSignal.timeout(10000) })
      .then((body) => { if (!("error" in body)) setData(body); })
      .catch(() => { /* the log still reads without it */ });
  }, []);
  if (!data) return null;
  // Four large zeros were the first thing a new install showed. Counts appear
  // only once there is something to count, as one line of text.
  if (!data.shown && !data.opened && !data.avoided && !data.confirmed) return null;
  // One sentence, said the way a person would say it. The counts are the
  // news, so they come after what they count.
  const parts = [
    data.opened > 0 && <><Hint id="opened">opened</Hint> {plural(data.opened, "record")} themselves</>,
    data.avoided > 0 && <><Hint id="avoided">avoided</Hint> about {plural(data.avoided, "dead end")}</>,
    data.confirmed > 0 && <><Hint id="confirmed">marked</Hint> {data.confirmed} as helpful</>,
  ].filter(Boolean);
  return (
    <section class="helped" aria-label="ANVC activity">
      <p class="helped-line">
        {data.shown > 0
          ? <>Your agents were <Hint id="shown">shown</Hint> past work {plural(data.shown, "time")} in {plural(data.sessions, "session")}</>
          : <>Your agents</>}
        {parts.map((part, i) => <>{i === parts.length - 1 ? (data.shown > 0 || i > 0 ? " and " : " ") : data.shown > 0 || i > 0 ? ", " : " "}{part}</>)}.
      </p>
    </section>
  );
}
