#!/usr/bin/env python3
"""
X6: what the capture log already knows about whether this is helping.

Every number so far is either delivery — the record reached the agent — or a
single-turn plan on a hand-built case. Neither says anything about a real
project over weeks.

The capture log can, and nothing reads it but `ingest`. It records every file
read, every command run, and every session boundary, with timestamps. That is
enough to compute the things users of agent-memory tools say they care about
and have no way to measure:

  re-read rate          files a session read that an earlier session already
                        read. Practitioners built whole tools for this and use
                        "30+ touches against 1" as a stuck-loop signal.

  repeated failure      the same command failing the same way in two different
                        sessions. The one thing a record of a dead end exists
                        to prevent, and the one nobody logs.

  walked into a wall    a file edited while an unresolved abandoned record
                        names it. The most direct proxy available: the warning
                        existed, and the work happened anyway.

  session shape         duration and distinct files touched, which capture
                        answers better than the record index can — the index
                        dedupes paths deliberately, so it cannot tell a file
                        read once from a file read twenty times.

No agent cooperation, so nothing here can be forgotten or gamed. These are
proxies, not outcomes: a re-read may be diligence rather than amnesia, and a
repeated failure may be a genuinely flaky test. They are worth having because
they move without anyone being asked a question.

    python3 proxies.py                    # ~/.anvc/capture, current repo
    python3 proxies.py --repo /path/to/x --capture ~/.anvc/capture
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


def rows(capture: Path, repo: str | None) -> list[dict]:
    out: list[dict] = []
    for f in sorted(capture.glob("*.jsonl")):
        for line in f.read_text(errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if repo and r.get("repo") != repo:
                continue
            if r.get("session_id"):
                out.append(r)
    return out


def when(r: dict) -> datetime | None:
    try:
        return datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
    except Exception:
        return None


def open_dead_end_files(repo: str) -> dict[str, str]:
    """Files named by an abandoned record nothing has resolved, to its goal.

    Shelling out to the CLI rather than reimplementing the fold: `openDeadEnds`
    already excludes anything a later kept attempt resolved, and a second
    implementation here would drift from it.
    """
    files: dict[str, str] = {}
    try:
        refs = subprocess.run(["git", "-C", repo, "for-each-ref", "--format=%(objectname)", "refs/anvc/"],
                              capture_output=True, text=True, timeout=30).stdout.split()
        resolved: set[str] = set()
        records: list[dict] = []
        for oid in refs:
            blob = subprocess.run(["git", "-C", repo, "cat-file", "blob", oid],
                                  capture_output=True, text=True, timeout=30).stdout
            try:
                rec = json.loads(blob)
            except json.JSONDecodeError:
                continue
            records.append(rec)
            if rec.get("parent") and rec.get("outcome", {}).get("status") == "kept":
                resolved.add(rec["parent"])
        for rec in records:
            if rec.get("outcome", {}).get("status") != "abandoned" or rec.get("id") in resolved:
                continue
            for path in rec.get("delta", {}).get("files", []) or []:
                files[path] = rec.get("intent", {}).get("goal", "(no goal)")
    except Exception as e:
        print(f"  (could not read records: {e})", file=sys.stderr)
    return files


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", default=str(Path.home() / ".anvc" / "capture"))
    ap.add_argument("--repo", default=os.getcwd())
    args = ap.parse_args(argv)

    repo = subprocess.run(["git", "-C", args.repo, "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True).stdout.strip() or args.repo
    events = rows(Path(args.capture), repo)
    if not events:
        print(f"no captured events for {repo} in {args.capture}", file=sys.stderr)
        return 1

    # ---------------------------------------------------------------- shape
    sessions: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        sessions[e["session_id"]].append(e)

    ordered = sorted(sessions.items(), key=lambda kv: min(
        (when(e) for e in kv[1] if when(e)), default=datetime.max.replace(tzinfo=None)))

    # ------------------------------------------------------------- re-reads
    # A file is "re-read" when a later session reads what an earlier one
    # already read. Within one session a re-read is ordinary work; across a
    # boundary it is the thing a record is supposed to prevent.
    seen_before: set[str] = set()
    reread = Counter()
    first_read = Counter()
    for sid, evs in ordered:
        mine = {e["path"] for e in evs if e.get("tool") == "Read" and e.get("path")}
        for p in mine:
            (reread if p in seen_before else first_read)[p] += 1
        seen_before |= mine

    # -------------------------------------------------- repeated failures
    # Normalised the way X0 does it: the verb plus file-like operands, so the
    # same command with a different flag is still the same attempt.
    def shape(cmd: str) -> str:
        head = cmd.strip().split()[0].split("/")[-1] if cmd.strip() else ""
        paths = sorted(set(re.findall(r"[\w./-]+\.[A-Za-z0-9]{1,5}", cmd)))
        return f"{head}|{','.join(paths)}" if paths else head

    failed_in: dict[str, set[str]] = defaultdict(set)
    for sid, evs in ordered:
        for e in evs:
            if e.get("tool") == "Bash" and e.get("ok") is False and e.get("command"):
                failed_in[shape(e["command"])].add(sid)
    repeated = {k: v for k, v in failed_in.items() if len(v) > 1 and k}

    # ------------------------------------------------- walked into a wall
    warned = open_dead_end_files(repo)
    walked: list[tuple[str, str]] = []
    for sid, evs in ordered:
        for e in evs:
            if e.get("tool") not in ("Edit", "Write", "NotebookEdit") or not e.get("path"):
                continue
            rel = e["path"][len(repo) + 1:] if e["path"].startswith(repo) else e["path"]
            if rel in warned:
                walked.append((rel, warned[rel]))

    # ------------------------------------------------------------- report
    # Sessions with almost no events are usually a probe or a crashed start,
    # and with a handful of real sessions they drag a median to nonsense: two
    # two-event stubs beside one 3,842-event session reported a median of 0.2
    # minutes. Reported as a spread over the substantial ones instead, with the
    # count of what was set aside, so the thinness is visible rather than
    # averaged away.
    SUBSTANTIAL = 20
    durations = []
    thin = 0
    for sid, evs in ordered:
        times = [t for t in (when(e) for e in evs) if t]
        if len(evs) < SUBSTANTIAL or len(times) < 2:
            thin += 1
            continue
        durations.append((max(times) - min(times)).total_seconds() / 60)
    durations.sort()

    total_reads = sum(reread.values()) + sum(first_read.values())
    print(json.dumps({
        "repo": repo,
        "sessions": len(sessions),
        "events": len(events),
        "sessions_with_real_work": len(durations),
        "sessions_too_thin_to_time": thin,
        "session_minutes": {
            "shortest": round(durations[0], 1),
            "median": round(durations[len(durations) // 2], 1),
            "longest": round(durations[-1], 1),
        } if durations else None,
        "reads": {
            "distinct_files": len(reread) + len(first_read),
            "first_time": sum(first_read.values()),
            "already_read_by_an_earlier_session": sum(reread.values()),
            "rate": round(sum(reread.values()) / total_reads, 3) if total_reads else None,
        },
        "commands_failing_in_more_than_one_session": len(repeated),
        "edits_to_a_file_with_an_open_dead_end": len(walked),
    }, indent=2))

    if reread:
        print("\nmost re-read across sessions:", file=sys.stderr)
        for path, n in reread.most_common(8):
            print(f"  {n:3d}  {path}", file=sys.stderr)
    if repeated:
        print("\nsame command failing in several sessions:", file=sys.stderr)
        for cmd, sids in sorted(repeated.items(), key=lambda kv: -len(kv[1]))[:8]:
            print(f"  {len(sids)} sessions  {cmd[:70]}", file=sys.stderr)
    if walked:
        print("\nedited despite an open dead end naming the file:", file=sys.stderr)
        for path, goal in walked[:8]:
            print(f"  {path}  ← {goal[:60]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
