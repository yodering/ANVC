#!/usr/bin/env python3
"""
X0: how often does an agent retry an approach that already failed?

The kill criterion for the whole product. Under ~5% and a log of abandoned
attempts is not worth building; over ~20% and it clearly is. Nobody has
published this number — checked against AgentDebug/AgentErrorBench, "Beyond
Resolution Rates" (trajectory length only) and SE-Agent (qualitative only).

It can be answered without spending anything on inference, because three public
corpora contain complete agent trajectories *including the failures*. This
script counts from those.

What a trajectory actually looks like (verified against the real data, not the
dataset card): `trajectory` is a flat message list of role/text, not structured
actions. An `ai` message states a plan and ends with a command in a fenced
block; the following `user` message is that command's output. So an action is a
command parsed out of a fence, and its outcome is whether the next observation
looks like a failure.

Deliberately conservative. Every rule here errs toward *not* counting a retry,
because the number is the argument and an inflated one is worthless.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- parsing

FENCE = re.compile(r"```(?:[a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)

def commands(text: str) -> list[str]:
    """Commands an assistant message issued, in order.

    SWE-agent puts exactly one command in a fenced block per step, but a
    message can carry several fences, and some carry prose in a fence. Lines
    are kept whole so a multi-line heredoc stays one action.
    """
    out: list[str] = []
    for block in FENCE.findall(text or ""):
        body = block.strip()
        if body:
            out.append(body)
    return out


# Output that means the command did not do what was asked. Anchored on shapes
# that appear in real tool output rather than on the word "error" anywhere,
# which matches ordinary prose and source code.
FAILURE = re.compile(
    r"(?:^|\n)\s*(?:"
    r"Traceback \(most recent call last\)"
    r"|(?:Syntax|Name|Type|Value|Import|Module|Attribute|Key|Index|Runtime|OS|IO)Error\b"
    r"|ModuleNotFoundError\b"
    r"|command not found"
    r"|No such file or directory"
    r"|.{0,40}not found\b"
    r"|Permission denied"
    r"|fatal: "
    r"|error: "
    r"|ERROR: "
    r"|FAILED\b"
    r"|AssertionError\b"
    r"|\d+ failed"
    r"|Your (?:proposed edit|edit) has introduced"   # SWE-agent lint rejection
    r"|Usage: "                                      # wrong invocation
    r"|invalid (?:option|syntax|argument)"
    r"|Cannot |cannot "
    r")",
    re.IGNORECASE,
)

# A test run reporting zero failures is a success even if the word "error"
# appears somewhere in its output.
SUCCESS_OVERRIDE = re.compile(
    r"(?:^|\n).{0,40}(?:"
    r"\b0 failed"
    r"|all tests passed"
    r"|OK\s*$"
    r"|=+ \d+ passed"
    r")",
    re.IGNORECASE | re.MULTILINE,
)


def failed(observation: str) -> bool:
    """Whether an observation reads as a failed command."""
    text = observation or ""
    if SUCCESS_OVERRIDE.search(text):
        return False
    return bool(FAILURE.search(text))


# ---------------------------------------------------------------- normalising

# Words that make two commands the same *approach* rather than the same string.
# `python -m pytest x` and `pytest x` are one approach; `open a.py` and
# `open b.py` are not.
NOISE = re.compile(r"\s+")
PATHY = re.compile(r"[\w./-]+\.[A-Za-z0-9]{1,5}")

def approach(command: str) -> str | None:
    """A command reduced to the approach it represents.

    Returns None for commands that carry no approach worth comparing — pure
    navigation and inspection. Retrying `ls` is not repeating a failed
    approach; retrying the same edit or the same test invocation is.
    """
    cmd = NOISE.sub(" ", (command or "").strip())
    if not cmd:
        return None

    head = cmd.split(" ", 1)[0].split("/")[-1]

    # Reading the filesystem is not an approach. Excluded so that an agent
    # groping around after a failure is never mistaken for a retry.
    if head in {
        "ls", "cd", "pwd", "cat", "head", "tail", "less", "more", "find",
        "grep", "rg", "which", "echo", "wc", "file", "tree", "stat", "diff",
        "scroll_down", "scroll_up", "goto", "open", "search_file",
        "search_dir", "find_file", "submit", "exit",
    }:
        return None

    # Keep the verb plus the file-like operands, drop flags and line numbers:
    # the same edit retried at a different line is still the same approach, and
    # the same test retried is still the same test.
    paths = sorted(set(PATHY.findall(cmd)))
    return f"{head}|{','.join(paths)}" if paths else head


# ---------------------------------------------------------------- counting

@dataclass
class Result:
    trajectories: int = 0
    with_retry: int = 0
    resolved: int = 0
    resolved_with_retry: int = 0
    steps: list[int] = field(default_factory=list)
    retry_counts: list[int] = field(default_factory=list)
    examples: list[dict] = field(default_factory=list)
    skipped_no_actions: int = 0

    def rate(self) -> float:
        return self.with_retry / self.trajectories if self.trajectories else 0.0


def signature(observation: str) -> str:
    """The identity of a failure, ignoring the parts that always differ.

    Re-running a test after an edit is ordinary debugging, not a repeated
    failed approach — and on real data it is the common case: one trajectory
    ran the same script seven times, failing at line 2, then 3, then 11, then
    14. The agent was making progress. Only a failure that comes back
    *identical* means the agent learned nothing.

    So line numbers, addresses, temp paths and timings are stripped, and what
    remains is the exception type and message.
    """
    text = observation or ""
    # Strip the harness's own trailing prompt. It is identical on every
    # observation, so leaving it in makes two unrelated failures look alike —
    # and it is what the last-two-lines fallback grabs by default.
    text = re.sub(r"\n\(Open file:.*$", "", text, flags=re.DOTALL)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    # The last exception line is the actual failure; the frames above it are
    # the path taken to it and shift with every edit.
    tail = [l for l in lines if re.match(r"^[A-Za-z_.]*(?:Error|Exception|Failure)\b", l)]
    if not tail:
        # SWE-agent's lint rejection and similar harness refusals carry their
        # reason on the first line rather than as an exception.
        tail = [l for l in lines[:3] if FAILURE.search("\n" + l)]
    core = tail[-1] if tail else " ".join(lines[-2:])
    core = re.sub(r"0x[0-9a-f]+", "0xADDR", core)
    core = re.sub(r"\bline \d+", "line N", core)
    core = re.sub(r"\b\d+\.\d+s?\b", "N", core)
    core = re.sub(r"/tmp/[\w./-]+", "/tmp/PATH", core)
    core = re.sub(r"\d+", "N", core)
    return NOISE.sub(" ", core)[:200]


def scan(trajectory: list[dict]) -> tuple[int, int, list[str]]:
    """Count actions and retries-of-a-failed-approach in one trajectory.

    Returns (actions, retries, sample of repeated approaches).

    A retry is the strict case: the same approach is attempted again **and
    fails the same way**. Approach A failing, then A failing differently, is
    an agent iterating; A failing identically is an agent going in circles.
    Attempting A again after it succeeded is never a retry.
    """
    # approach -> the failure signatures it has already produced
    failures: dict[str, set[str]] = {}
    succeeded: set[str] = set()
    retried: list[str] = []
    actions = 0

    messages = [m for m in trajectory if m.get("role") in {"ai", "user"}]
    for i, message in enumerate(messages):
        if message.get("role") != "ai":
            continue
        # The observation is the next user message; without one the command's
        # outcome is unknown and it is not counted either way.
        observation = None
        if i + 1 < len(messages) and messages[i + 1].get("role") == "user":
            observation = messages[i + 1].get("text") or ""
        if observation is None:
            continue

        bad = failed(observation)
        sig = signature(observation) if bad else None
        for command in commands(message.get("text") or ""):
            key = approach(command)
            if key is None:
                continue
            actions += 1
            if bad:
                seen = failures.setdefault(key, set())
                # Same approach, same failure, and it never worked in between.
                if sig in seen and key not in succeeded:
                    retried.append(f"{key} → {sig[:60]}")
                seen.add(sig)
            else:
                succeeded.add(key)

    return actions, len(retried), retried[:3]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: extract.py <rows.jsonl> [more.jsonl ...]", file=sys.stderr)
        return 2

    result = Result()
    for path in argv[1:]:
        for line in Path(path).read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            trajectory = row.get("trajectory")
            if not isinstance(trajectory, list) or not trajectory:
                continue

            actions, retries, sample = scan(trajectory)
            if actions == 0:
                result.skipped_no_actions += 1
                continue

            result.trajectories += 1
            result.steps.append(actions)
            # `exit_status` is the dataset's own verdict; "submitted" alone does
            # not mean the patch was correct, so resolution is read from it
            # only when it says so explicitly.
            resolved = str(row.get("exit_status") or "").startswith("submitted")
            if resolved:
                result.resolved += 1
            if retries:
                result.with_retry += 1
                result.retry_counts.append(retries)
                if resolved:
                    result.resolved_with_retry += 1
                if len(result.examples) < 12:
                    result.examples.append({
                        "instance_id": row.get("instance_id"),
                        "exit_status": row.get("exit_status"),
                        "actions": actions,
                        "retries": retries,
                        "repeated": sample,
                    })

    n = result.trajectories
    print(f"trajectories analysed      {n}")
    print(f"  skipped (no actions)     {result.skipped_no_actions}")
    if not n:
        return 1
    print()
    print(f"RETRIED A FAILED APPROACH  {result.with_retry}  ({100*result.rate():.1f}%)")
    print()
    unresolved = n - result.resolved
    ur = result.with_retry - result.resolved_with_retry
    print(f"  among submitted          {result.resolved_with_retry}/{result.resolved}"
          f"  ({100*result.resolved_with_retry/result.resolved:.1f}%)" if result.resolved else "")
    print(f"  among not submitted      {ur}/{unresolved}"
          f"  ({100*ur/unresolved:.1f}%)" if unresolved else "")
    if result.retry_counts:
        rc = sorted(result.retry_counts)
        print(f"  repeats per trajectory   median {rc[len(rc)//2]}, max {rc[-1]}")
    steps = sorted(result.steps)
    print(f"  actions per trajectory   median {steps[len(steps)//2]}, max {steps[-1]}")
    print()
    print("examples:")
    for e in result.examples[:6]:
        print(f"  {e['instance_id']}  {e['retries']} repeat(s) of {e['repeated']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
