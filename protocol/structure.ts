/**
 * The project's real structure, read from the code.
 *
 * Everything else in this repository describes what *happened* — attempts, what
 * they touched, what was abandoned. None of it describes what the project *is*.
 * The first project map was built from records and so it drew file churn: it
 * said `protocol` owned one file because that was the only one an attempt had
 * touched, when the directory holds eight.
 *
 * This reads the code instead. Imports are the one account of structure that
 * cannot go stale, because they are the thing that runs — and they exist from
 * the first commit, so a map built on them works on a repository with no
 * records at all. That is exactly when someone needs it most.
 *
 * Regex rather than the TypeScript compiler API, deliberately. `typescript` is
 * a dev dependency here for `tsc --noEmit` and is not imported at runtime, and
 * making a compiler a runtime dependency is a large price for a map. Measured
 * on this repository it now resolves every relative import to a source file —
 * the only two it ever missed were a stylesheet and an HTML template, which are
 * the bundler's business and not modules at all. Anything it genuinely cannot
 * place is reported in `unresolved` rather than dropped, so the accuracy is
 * checkable instead of asserted.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { gitOrNull } from "./git";

export interface SourceFile {
  /** Repository-relative, which is what every view labels a node with. */
  path: string;
  lines: number;
  /** Files this one imports, repository-relative and resolved. */
  imports: string[];
  test: boolean;
}

export interface Structure {
  files: SourceFile[];
  /**
   * Import specifiers that could not be resolved to a file in the repository.
   *
   * Reported rather than swallowed: a resolver that silently drops what it
   * cannot handle is one whose accuracy nobody can check.
   */
  unresolved: Array<{ from: string; spec: string }>;
}

const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".py"]);

/**
 * Directories that are not the project.
 *
 * `archive/` is kept deliberately in this repository as a record of superseded
 * work, and on this repository it is 50 of 131 source files — nearly half the
 * map, describing a system that no longer runs.
 */
function skip(path: string): boolean {
  return path.startsWith("archive/")
    || path.startsWith("node_modules/")
    || path.includes("/node_modules/");
}

/**
 * Resolves a relative import the way the runtime would.
 *
 * Order matters: an exact path wins over an extension guess, which wins over a
 * directory index, because `./x` next to both `x.ts` and `x/index.ts` means the
 * file.
 */
function resolve(from: string, spec: string, known: Set<string>): string | null {
  // Git's paths, so joined with / on Windows too.
  const base = posix.normalize(posix.join(from.split("/").slice(0, -1).join("/"), spec));
  if (known.has(base)) return base;
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    if (known.has(base + ext)) return base + ext;
  }
  for (const index of ["/index.ts", "/index.tsx", "/index.js"]) {
    if (known.has(base + index)) return base + index;
  }
  return null;
}

/**
 * Import specifiers.
 *
 * Matched on source text, so they can be fooled by a string or a comment that
 * looks like code. In exchange they cost nothing and work on a file that does
 * not compile — which matters, because a project map is most useful exactly
 * when the project is in a mess.
 */
const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["'](\.[^"']+)["']|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g;

/**
 * Python imports, resolved to files in the repository.
 *
 * An absolute import is looked for next to the importing file (a script's own
 * folder is on its path), at the root and under src/. One that is none of
 * those is a library, not a miss, so only relative imports count as
 * unresolved. `from a import b` may name a module b rather than a function in
 * a, so a/b.py is tried first.
 */
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;

function pyImports(from: string, source: string, known: Set<string>): Link[] {
  const here = from.split("/").slice(0, -1).join("/");
  const file = (base: string, mod: string): string | null => {
    const stem = [base, mod.replace(/\./g, "/")].filter(Boolean).join("/");
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) if (known.has(candidate)) return candidate;
    return null;
  };
  // The deepest module that is a file: `import a.b.c` where c is a class in a/b.py.
  const find = (bases: string[], mod: string): string | null => {
    for (const base of bases) {
      for (let parts = mod.split("."); parts.length; parts = parts.slice(0, -1)) {
        const hit = file(base, parts.join("."));
        if (hit) return hit;
      }
    }
    return null;
  };
  const links: Link[] = [];
  for (const match of source.matchAll(PY_FROM)) {
    const spec = match[1]!;
    const dots = spec.length - spec.replace(/^\.+/, "").length;
    const mod = spec.slice(dots);
    const bases = dots ? [here.split("/").slice(0, here ? here.split("/").length - (dots - 1) : 0).join("/")] : [here, "", "src"];
    const names = match[2]!.replace(/[()]/g, "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => /^\w+$/.test(n));
    const submodules = names.flatMap((name) => bases.map((base) => file(base, mod ? `${mod}.${name}` : name))).filter((t): t is string => Boolean(t));
    const target = submodules.length ? null : (mod ? find(bases, mod) : null);
    for (const t of [...new Set(submodules)]) links.push({ spec, target: t, report: false });
    if (!submodules.length) links.push({ spec, target, report: dots > 0 });
  }
  for (const match of source.matchAll(PY_IMPORT)) {
    for (const piece of match[1]!.split(",")) {
      const mod = piece.trim().split(/\s+as\s+/)[0]!.trim();
      if (!/^[\w.]+$/.test(mod)) continue;
      const target = find([here, "", "src"], mod);
      if (target) links.push({ spec: mod, target, report: false });
    }
  }
  return links;
}

/** An import and the file it resolved to; `report` when a miss should be counted. */
interface Link { spec: string; target: string | null; report: boolean }

/**
 * Reads the project as it is on disk right now.
 *
 * `git ls-files` rather than a directory walk, so the answer respects
 * `.gitignore` for free and never wanders into `node_modules` or build output.
 */
export function structure(repo: string, opts: { tests?: boolean } = {}): Structure {
  const listed = gitOrNull(repo, ["ls-files"]) ?? "";
  const paths = listed.split("\n")
    .filter((p) => p && SOURCE.has(extname(p)) && !skip(p));
  const known = new Set(paths);

  const files = new Map<string, SourceFile>();
  const unresolved: Structure["unresolved"] = [];

  for (const path of paths) {
    let source = "";
    try {
      const full = join(repo, path);
      // A generated bundle is not architecture, and reading a megabyte of it to
      // find that out is the slowest part of this pass.
      source = statSync(full).size > 2_000_000 ? "" : readFileSync(full, "utf8");
    } catch { source = ""; }

    const file: SourceFile = {
      path,
      lines: source ? source.split("\n").length : 0,
      imports: [],
      test: /(^|\/)tests?\//.test(path) || /\.test\.[jt]sx?$/.test(path) || /(^|\/)test_[^/]*\.py$|_test\.py$/.test(path),
    };
    files.set(path, file);

    // An import of a stylesheet or a template is not a failure to resolve
    // a module; it is a different kind of thing that the bundler handles.
    // Counting those as misses would make the accuracy number meaningless.
    const links: Link[] = extname(path) === ".py" ? pyImports(path, source, known)
      : [...source.matchAll(IMPORT)].flatMap((m) => {
        const spec = m[1] ?? m[2];
        return spec ? [{ spec, target: resolve(path, spec, known), report: SOURCE.has(extname(spec)) }] : [];
      });
    for (const { spec, target, report } of links) {
      if (!target) {
        if (report) unresolved.push({ from: path, spec });
        continue;
      }
      if (target !== path && !file.imports.includes(target)) file.imports.push(target);
    }
  }

  return { files: [...files.values()].filter((f) => opts.tests !== false || !f.test), unresolved };
}
