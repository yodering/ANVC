/**
 * The structure reader is the one part of the map that claims to describe the
 * project rather than our work on it, so what it must never do is quietly
 * misreport. These pin the resolution rules and, more importantly, that an
 * import it cannot place is reported instead of dropped.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { structure } from "../protocol/structure";
import { git, gitRepo } from "./helpers";

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = gitRepo();
  for (const [path, body] of Object.entries(files)) {
    const cut = path.lastIndexOf("/");
    if (cut > 0) await mkdir(join(repo, path.slice(0, cut)), { recursive: true });
    await writeFile(join(repo, path), body);
  }
  // `git ls-files` only sees tracked files, which is the point: the reader
  // respects .gitignore for free rather than reimplementing it.
  git(repo, "add", "-A");
  return repo;
}

test("imports resolve to real files", async () => {
  const repo = await repoWith({
    "core/thing.ts": "export function thing() {}\n",
    "app/use.ts": 'import { thing } from "../core/thing";\nthing();\n',
  });
  const s = structure(repo);
  const use = s.files.find((f) => f.path === "app/use.ts")!;
  expect(use.imports).toEqual(["core/thing.ts"]);
  expect(s.unresolved).toEqual([]);
});

test("an extensionless import finds the file, and a directory finds its index", async () => {
  const repo = await repoWith({
    "a.ts": 'import "./lib";\nimport "./pack";\n',
    "lib.ts": "export const lib = 1;\n",
    "pack/index.ts": "export const pack = 1;\n",
  });
  const s = structure(repo);
  expect(s.files.find((f) => f.path === "a.ts")!.imports.sort())
    .toEqual(["lib.ts", "pack/index.ts"]);
});

test("an import of something that is not a module is not counted as a miss", async () => {
  const repo = await repoWith({
    "ui.tsx": 'import "./ui.css";\nimport "./page.html";\n',
    "ui.css": "body { color: red }\n",
  });
  const s = structure(repo);
  // A stylesheet is the bundler's business. Counting it as unresolved would
  // make the accuracy figure meaningless.
  expect(s.unresolved).toEqual([]);
});

test("an import that genuinely points nowhere is reported, not dropped", async () => {
  const repo = await repoWith({ "a.ts": 'import "./missing.ts";\n' });
  const s = structure(repo);
  expect(s.unresolved).toEqual([{ from: "a.ts", spec: "./missing.ts" }]);
});

test("tests are marked and can be left out without losing the files they import", async () => {
  const repo = await repoWith({
    "core/thing.ts": "export const thing = 1;\n",
    "tests/thing.test.ts": 'import { thing } from "../core/thing";\n',
  });
  const withTests = structure(repo);
  expect(withTests.files.find((f) => f.path === "tests/thing.test.ts")!.test).toBe(true);
  const without = structure(repo, { tests: false });
  expect(without.files.map((f) => f.path)).toEqual(["core/thing.ts"]);
});

test("a file untracked by git is not part of the project", async () => {
  const repo = gitRepo();
  await writeFile(join(repo, "tracked.ts"), "export const a = 1;\n");
  git(repo, "add", "tracked.ts");
  await writeFile(join(repo, "scratch.ts"), "export const b = 2;\n");
  const s = structure(repo);
  expect(s.files.map((f) => f.path)).toEqual(["tracked.ts"]);
});

test("Python imports resolve to modules and packages, and libraries are not misses", async () => {
  const repo = await repoWith({
    "config.py": "LIMIT = 3\n",
    "backtesting/__init__.py": "",
    "backtesting/archive.py": "class BarArchive:\n    pass\n\ndef _private():\n    pass\n",
    "backtesting/data.py": "import json\nfrom pathlib import Path\nfrom backtesting.archive import BarArchive\nfrom config import (\n    LIMIT,\n)\nfrom .greeks import delta\n",
    "backtesting/greeks.py": "def delta():\n    pass\n",
    "scripts/run.py": "import sys\nimport helper\nfrom backtesting import data\nfrom .missing import nothing\n",
    "scripts/helper.py": "",
    "tests/test_data.py": "from backtesting.data import BarArchive\n",
  });
  const s = structure(repo);
  const file = (p: string) => s.files.find((f) => f.path === p)!;
  expect(file("backtesting/data.py").imports.sort()).toEqual(["backtesting/archive.py", "backtesting/greeks.py", "config.py"]);
  // `from backtesting import data` names the module data.py, and a script's own folder is on its path.
  expect(file("scripts/run.py").imports.sort()).toEqual(["backtesting/data.py", "scripts/helper.py"]);
  expect(file("tests/test_data.py").test).toBe(true);
  // json, pathlib and sys are libraries; only the relative import that points nowhere is a miss.
  expect(s.unresolved).toEqual([{ from: "scripts/run.py", spec: ".missing" }]);
});
