#!/usr/bin/env python3
"""
X0b: is agent merge conflict real work, or mostly lockfiles?

AgenticFlict reports that 27.67% of non-merged agent PRs have textual
conflicts, and contains **no triviality breakdown at all** — zero mentions of
lockfiles, whitespace, imports or generated files. The only conflict_type
values are Git-mechanical. So the headline number could be almost entirely
`package-lock.json`, and intent-merge would be worth very little.

It has a `file_path` and `file_ext` column, so the breakdown can be computed.
This does that.

Data: Zenodo 20118379, CC-BY-4.0. `agenticflict_conflict_files_clean.csv`,
129,189 conflicted files.

Classification is deliberately pessimistic about our own case: anything
plausibly machine-generated counts as trivial, so the "real work" number is a
floor rather than a flattering estimate.
"""
from __future__ import annotations

import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Files a human never hand-edits. A conflict here is resolved by re-running a
# tool, so no amount of recorded intent helps.
LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
    "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
    "go.sum", "mix.lock", "pubspec.lock", "packages.lock.json", "gradle.lockfile",
    "uv.lock", "requirements.txt.lock", "flake.lock", "yarn-error.log",
}

# Paths that are build output or vendored dependencies.
GENERATED_PATH = re.compile(
    r"(?:^|/)(?:"
    r"dist|build|out|target|vendor|node_modules|__pycache__|\.next|\.nuxt"
    r"|coverage|htmlcov|site-packages|third_party|external|deps"
    r"|migrations?|generated|__generated__|\.generated|autogen"
    r"|snapshots?|__snapshots__|fixtures?|testdata|golden"
    r")(?:/|$)",
    re.IGNORECASE,
)

# Extensions that are data, config or artefacts rather than logic. A conflict
# in these is usually mechanical.
TRIVIAL_EXT = {
    # lock/dependency-ish
    "lock", "sum",
    # generated or binary artefacts
    "map", "min.js", "min.css", "pb.go", "pb2.py", "d.ts",
    "snap", "svg", "png", "jpg", "jpeg", "gif", "ico", "pdf", "woff", "woff2",
    "ttf", "eot", "mo", "po", "bin", "so", "dll", "dylib", "class", "jar",
    "whl", "gz", "zip", "tar", "wasm",
    # changelog and docs churn — real text, but merge-by-intent is not the tool
    "txt", "log", "csv", "tsv",
}

# Extensions that are source code or meaningful config. A conflict here is two
# agents disagreeing about behaviour — the case intent-merge targets.
SOURCE_EXT = {
    "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "go", "rs", "java", "kt",
    "kts", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "scala",
    "clj", "ex", "exs", "erl", "hs", "ml", "lua", "pl", "pm", "r", "jl",
    "dart", "vue", "svelte", "sql", "sh", "bash", "zsh", "fish", "ps1",
    "tf", "tfvars", "proto", "graphql", "gql",
}

# Config and metadata: real decisions live here (dependency versions, CI
# steps), but so does a lot of churn. Reported separately rather than folded
# into either side.
CONFIG_EXT = {
    "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
    "gradle", "xml", "plist", "dockerfile", "editorconfig",
}

DOC_EXT = {"md", "mdx", "rst", "adoc", "org", "tex", "html", "htm", "css", "scss", "sass", "less"}


def classify(path: str, ext: str) -> str:
    """One of: lockfile, generated, trivial, config, doc, source, unknown."""
    name = path.rsplit("/", 1)[-1]
    e = (ext or "").lower().lstrip(".")

    if name in LOCKFILES:
        return "lockfile"
    # Checked before extension, because dist/app.js is generated even though
    # .js is source.
    if GENERATED_PATH.search(path or ""):
        return "generated"
    if e in TRIVIAL_EXT or name.endswith((".min.js", ".min.css")):
        return "trivial"
    if e in SOURCE_EXT:
        return "source"
    if e in CONFIG_EXT or name.lower() in {"dockerfile", "makefile", "jenkinsfile"}:
        return "config"
    if e in DOC_EXT:
        return "doc"
    return "unknown"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: classify.py <agenticflict_conflict_files_clean.csv>", file=sys.stderr)
        return 2

    files = Counter()
    lines = Counter()
    by_agent: dict[str, Counter] = defaultdict(Counter)
    prs_with_source: set[str] = set()
    all_prs: set[str] = set()
    top_trivial = Counter()
    total_files = 0

    with Path(argv[1]).open(newline="") as handle:
        for row in csv.DictReader(handle):
            path = row.get("file_path") or ""
            kind = classify(path, row.get("file_ext") or "")
            try:
                n_lines = int(row.get("conflict_lines_in_file") or 0)
            except ValueError:
                n_lines = 0

            total_files += 1
            files[kind] += 1
            lines[kind] += n_lines
            by_agent[row.get("agent") or "?"][kind] += 1

            pr = row.get("pr_key") or ""
            if pr:
                all_prs.add(pr)
                # A PR counts as real work if *any* conflicted file is source.
                if kind == "source":
                    prs_with_source.add(pr)
            if kind in {"lockfile", "generated", "trivial"}:
                top_trivial[path.rsplit("/", 1)[-1]] += 1

    print(f"conflicted files: {total_files:,}   PRs: {len(all_prs):,}\n")

    print("by file kind:")
    order = ["source", "config", "doc", "lockfile", "generated", "trivial", "unknown"]
    for kind in order:
        n = files[kind]
        if not n:
            continue
        print(f"  {kind:10} {n:>7,} files ({100*n/total_files:>5.1f}%)"
              f"   {lines[kind]:>10,} conflict lines ({100*lines[kind]/max(sum(lines.values()),1):>5.1f}%)")

    trivial = files["lockfile"] + files["generated"] + files["trivial"]
    print(f"\n  mechanical (lock+generated+trivial)  {100*trivial/total_files:.1f}% of files")
    print(f"  source code                          {100*files['source']/total_files:.1f}% of files")

    print(f"\nPRs with at least one SOURCE conflict: {len(prs_with_source):,}"
          f" of {len(all_prs):,}  ({100*len(prs_with_source)/max(len(all_prs),1):.1f}%)")
    print("  ^ this is the population intent-merge could actually serve")

    print("\nmost common mechanical filenames:")
    for name, n in top_trivial.most_common(8):
        print(f"  {n:>6,}  {name}")

    print("\nsource-conflict share by agent:")
    for agent, counts in sorted(by_agent.items(), key=lambda kv: -sum(kv[1].values())):
        total = sum(counts.values())
        if total < 200:
            continue
        print(f"  {agent:<14} {100*counts['source']/total:>5.1f}% source"
              f"   ({total:,} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
