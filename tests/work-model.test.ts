import { expect, test } from "bun:test";
import { exampleWork } from "../server/example-work";
import {
  fileLink,
  filterTurns,
  groupSessions,
  turnArea,
  turnTitle,
  type Turn,
} from "../server/work-model";

test("search combines outcome, session and terms across goals, paths and command output", () => {
  const turns = exampleWork().turns;
  const result = filterTurns(
    turns,
    "path-only successor",
    "abandoned",
    "retrieval",
  );
  expect(result.map((turn) => turn.id)).toEqual(["example-2"]);
  expect(filterTurns(turns, "path-only successor", "kept", null)).toEqual([]);
  expect(filterTurns(turns, "successor", "all", "capture")).toEqual([]);
  expect(filterTurns(turns, "   ", "all", null)).toHaveLength(turns.length);
});

test("captured instructions are searchable but never presented as agent-written goals", () => {
  const turn = {
    ...exampleWork().turns[0]!,
    authored: false,
    intent: "Please just continue",
  };
  expect(turnTitle(turn)).toBe("Changed query.ts and 1 other file");
  expect(filterTurns([turn], "Please just continue", "all", null)).toHaveLength(
    1,
  );
  expect(turnTitle({ ...turn, filesWritten: [], shells: 0, reads: 0 })).toBe(
    "Untitled attempt",
  );
});

test("the No reason tab holds exactly the attempts the agent didn't record", () => {
  const [a, b] = exampleWork().turns;
  const saved = { ...b!, authored: false, status: "abandoned" as const };
  expect(filterTurns([a!, saved], "", "unexplained", null)).toEqual([saved]);
  expect(filterTurns([a!, saved], "", "abandoned", null)).toEqual([saved]);
});

test("session grouping is newest-first without mutating the server response", () => {
  const turns = exampleWork().turns.reverse();
  const ids = turns.map((turn) => turn.id);
  const groups = groupSessions(turns);
  expect(groups.map((group) => group.id)).toEqual([
    "retrieval",
    "capture",
    "lineage",
  ]);
  expect(groups[0]!.title).toBe("Hide dead ends once a later attempt resolves them");
  expect(groups[0]!.turns[0]!.id).toBe("example-1");
  expect(turns.map((turn) => turn.id)).toEqual(ids);
});

test("file links preserve special characters and pin evidence to its commit", () => {
  expect(
    fileLink("https://github.com/example/project", "src/why?#.ts", "abc123"),
  ).toBe("https://github.com/example/project/blob/abc123/src/why%3F%23.ts");
  expect(
    fileLink("https://github.com/example/project", "/private/file.ts", null),
  ).toBeNull();
  expect(
    fileLink("https://github.com/example/project", "src/../file.ts", null),
  ).toBeNull();
});

/**
 * A column of goal lines that all open the same way reads as a wall. The tag
 * gives the eye somewhere to land before the sentence, and it is derived from
 * the paths already in the record — no model, no extra field, and it cannot
 * drift from what the record says.
 */
test("the area tag says where the work happened", () => {
  const turn = (filesWritten: string[]) => ({ filesWritten } as Turn);

  expect(turnArea(turn(["protocol/record.ts"]))).toBe("protocol");
  expect(turnArea(turn(["protocol/record.ts", "protocol/query.ts"]))).toBe("protocol");
  expect(turnArea(turn(["server/api.ts", "protocol/query.ts"]))).toBe("protocol + server");
  // Three or more folders is itself the useful fact; naming them all would be
  // longer than the row it labels.
  expect(turnArea(turn(["a/x.ts", "b/y.ts", "c/z.ts"]))).toBe("3 folders");
  // A flat repository has no directory to name, so the file stands in.
  expect(turnArea(turn(["README.md"]))).toBe("README");
  // No files, no honest tag. A filler label still costs a glance.
  expect(turnArea(turn([]))).toBeNull();
});

test("a tag never grows long enough to crowd the title", () => {
  const long = ["some-very-long-directory-name/a.ts", "another-extremely-long-one/b.ts"];
  // Two long names joined are longer than the count, so it counts instead of
  // truncating into something unreadable.
  expect(turnArea({ filesWritten: long } as Turn)).toBe("2 folders");
});

/**
 * Every word this UI invented can explain itself.
 *
 * A reader cannot guess what "attempt", "abandoned", "captured" or a raw
 * session id like `sess-concurrency` mean, and nothing on screen used to say.
 */
test("the glossary covers the vocabulary and says something useful", async () => {
  const { HINTS } = await import("../server/glossary");

  // Every term the UI attaches a hint to has to exist, or the marker renders
  // nothing and the reader is back where they started.
  for (const key of ["authored", "captured", "anchor", "steps"]) {
    expect(HINTS[key]).toBeDefined();
  }

  for (const [key, hint] of Object.entries(HINTS)) {
    expect(hint.term.length, `${key} needs a label`).toBeGreaterThan(0);
    // Long enough to be unambiguous rather than short enough to look tidy —
    // a one-word gloss of a made-up word explains nothing.
    expect(hint.what.length, `${key} explanation is too thin`).toBeGreaterThan(30);
    // And short enough that it is read rather than skipped.
    expect(hint.what.length, `${key} explanation is too long`).toBeLessThan(220);
  }
});

test("search reaches the dense half: output, what was ruled out, and what was never checked", () => {
  const turns = exampleWork().turns;
  expect(filterTurns(turns, "content hash", "all", null).map((t) => t.id)).toEqual(["example-2"]);
  expect(filterTurns(turns, "renamed files", "all", null).map((t) => t.id)).toEqual(["example-2"]);
  expect(filterTurns(turns, "expected context to be null", "all", null).map((t) => t.id)).toEqual(["example-2"]);
});
