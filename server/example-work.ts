import type { Turn, WorkRepo } from "./work-model";

/** Plausible ANVC work history for the opt-in preview. Never persisted. */
export function exampleWork(): WorkRepo {
  const now = Date.now();
  const turn = (id: number, minutes: number, fields: Partial<Turn>): Turn => ({
    id: `example-${id}`,
    ref: `example/${id}`,
    tier: "shared",
    retired: null,
    run: "retrieval",
    start: new Date(now - minutes * 60_000).toISOString(),
    seconds: 0,
    status: "kept",
    intent: "",
    authored: true,
    anchorCommit: null,
    parent: null,
    supersedes: null,
    replacedBy: null,
    openDeadEnd: false,
    why: null,
    constraints: [],
    recheck: null,
    detail: null,
    reads: 0,
    writes: 0,
    shells: 0,
    filesWritten: [],
    actions: [],
    ...fields,
  });

  const turns = [
    turn(1, 12, {
      intent: "Hide dead ends once a later attempt resolves them",
      parent: "example-2",
      seconds: 840,
      reads: 2,
      writes: 2,
      filesWritten: ["protocol/query.ts", "emitters/claude-code/inject.ts"],
      why: "Follow the parent chain before showing a dead end. If later work replaced it, show the result instead of warning the next agent away from a solved path.",
      constraints: ["Keep the original record intact", "Show the warning only when it still applies"],
      actions: [
        { at: 0, kind: "read", label: "protocol/query.ts", full: "Read how open dead ends are selected from the record index." },
        { at: 165, kind: "read", label: "emitters/claude-code/inject.ts", full: "Trace which records reach the file-open hook." },
        { at: 430, kind: "write", label: "protocol/query.ts", full: "Exclude dead ends that later work resolved." },
        { at: 705, kind: "write", label: "emitters/claude-code/inject.ts", full: "Use the resolved set when composing file hints." },
      ],
    }),
    turn(2, 34, {
      intent: "Match old failures to the file being opened",
      parent: "example-3",
      status: "abandoned",
      seconds: 510,
      reads: 2,
      writes: 1,
      filesWritten: ["emitters/claude-code/inject.ts"],
      why: "A path match says the old attempt touched the file, but says nothing about whether the problem still exists. It surfaced a warning for work that had already been replaced.",
      recheck: "bun test tests/inject.test.ts",
      detail: {
        narrative: "Opening inject.ts brought back a warning about an approach that a later attempt had already replaced. Matching on the path found the right file but the wrong record.",
        output: "$ bun test tests/inject.test.ts\n(fail) a resolved dead end is not repeated on file open\n  expected context to be null\n  received \"Work on emitters/claude-code/inject.ts that was abandoned: ...\"\n\n 22 pass\n 1 fail",
        ruled_out: [
          { approach: "Hide warnings older than a week", because: "Age says nothing about whether the problem was fixed. Old warnings can still be true." },
          { approach: "Match on file content hash", because: "Any unrelated edit to the file would hide a warning that still applies." },
        ],
        not_investigated: ["Whether renamed files keep their warnings"],
      },
      actions: [
        { at: 0, kind: "read", label: "emitters/claude-code/inject.ts", full: "Inspect the file-open matching rule." },
        { at: 210, kind: "write", label: "emitters/claude-code/inject.ts", full: "Try matching prior failures by touched path." },
        { at: 465, kind: "read", label: "protocol/query.ts", full: "Found a successor record, but the path-only hint remained visible." },
      ],
    }),
    turn(3, 51, {
      intent: "Find why a resolved warning still appears",
      seconds: 390,
      reads: 2,
      why: "The hook matched the file correctly. The query did not check whether a later record had replaced the failure.",
      actions: [
        { at: 0, kind: "read", label: "emitters/claude-code/inject.ts", full: "Follow the file-open hook from path lookup to injected text." },
        { at: 185, kind: "read", label: "protocol/query.ts", full: "Compare the returned dead end with its successor record." },
      ],
    }),
    turn(4, 190, {
      run: "capture",
      intent: "Keep the command output behind each captured step",
      parent: "example-5",
      seconds: 720,
      reads: 2,
      writes: 2,
      filesWritten: ["emitters/claude-code/capture.ts", "protocol/ingest.ts"],
      why: "The capture now carries relevant output alongside the command. A later reader can see what failed without reconstructing the session.",
      actions: [
        { at: 0, kind: "read", label: "emitters/claude-code/capture.ts", full: "Inspect the transcript fields available for command results." },
        { at: 275, kind: "write", label: "emitters/claude-code/capture.ts", full: "Retain the command and its returned output in the captured step." },
        { at: 560, kind: "write", label: "protocol/ingest.ts", full: "Carry that evidence into the stored record." },
      ],
    }),
    turn(5, 214, {
      run: "capture",
      intent: "Record command success as a single flag",
      status: "abandoned",
      seconds: 330,
      reads: 2,
      writes: 1,
      filesWritten: ["emitters/claude-code/capture.ts"],
      why: "A pass or fail flag hides the message that explains the failure. Keep the output itself, with the command that produced it.",
      detail: {
        output: "step 14  bun test  exit 1\n(the flag was all that was stored; the failing test name was lost)",
        not_investigated: ["How much output to keep for very long test runs"],
      },
      actions: [
        { at: 0, kind: "read", label: "emitters/claude-code/capture.ts", full: "Check what the command result hook records." },
        { at: 145, kind: "write", label: "emitters/claude-code/capture.ts", full: "Try storing only the command status." },
        { at: 285, kind: "read", label: "protocol/ingest.ts", full: "The ingested step could say that it failed, but not why." },
      ],
    }),
    turn(6, 1460, {
      run: "lineage",
      intent: "Link a discarded approach to what replaced it",
      seconds: 670,
      reads: 1,
      writes: 2,
      filesWritten: ["protocol/record.ts", "protocol/query.ts"],
      why: "The next attempt can name its parent. Readers can follow an abandoned approach forward to the work that superseded it.",
      actions: [
        { at: 0, kind: "read", label: "protocol/record.ts", full: "Find the parent field in the checkpoint envelope." },
        { at: 205, kind: "write", label: "protocol/record.ts", full: "Accept a parent ID when writing the next attempt." },
        { at: 490, kind: "write", label: "protocol/query.ts", full: "Resolve both sides of the parent link for readers." },
      ],
    }),
  ];

  return {
    name: "anvc (sample)",
    forge: null,
    turns,
    stats: { records: turns.length, abandoned: 2, sessions: 3 },
  };
}
