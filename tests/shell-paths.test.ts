import { expect, test } from "bun:test";
import { shellPaths } from "../protocol/shell-paths";

const paths = (cmd: string) => shellPaths(cmd).map((p) => `${p.kind}:${p.path}`).sort();

test("extracts writes from redirects, sed and inline python", () => {
  expect(paths("cat > protocol/record.ts <<'EOF'")).toEqual(["write:protocol/record.ts"]);
  expect(paths("echo hi >> docs/status.md")).toEqual(["write:docs/status.md"]);
  expect(paths("sed -i 's/a/b/' harness/run.ts")).toEqual(["write:harness/run.ts"]);
  expect(paths(`python3 -c "open('docs/plan.md','w').write(s)"`)).toEqual(["write:docs/plan.md"]);
  expect(paths(`python3 -c "s=open('spec/v0.md').read()"`)).toEqual(["read:spec/v0.md"]);
});

test("extracts reads from read-only commands", () => {
  expect(paths("cat harness/run.ts")).toEqual(["read:harness/run.ts"]);
  expect(paths("head -20 README.md")).toEqual(["read:README.md"]);
  expect(paths("wc -l docs/thesis.md")).toEqual(["read:docs/thesis.md"]);
});

test("cp and mv read the source and write the destination", () => {
  expect(paths("cp a.ts b.ts")).toEqual(["read:a.ts", "write:b.ts"]);
  expect(paths("mv old.md new.md")).toEqual(["read:old.md", "write:new.md"]);
});

test("a path both read and written counts as a write", () => {
  // `cat f > f.bak` writes the backup; a path doing both is a write.
  expect(paths("cat f.ts > f.ts")).toEqual(["write:f.ts"]);
});

test("refuses non-literal operands rather than inventing paths", () => {
  // A fabricated read would corrupt the overlap number this exists to measure.
  expect(paths("cat $FILE")).toEqual([]);
  expect(paths("cat *.ts")).toEqual([]);
  expect(paths("cat `which bun`")).toEqual([]);
  expect(paths("echo x > /dev/null")).toEqual([]);
  expect(paths("bun test 2>&1 | tail -3")).toEqual([]);
  expect(paths("grep -c foo < <(cat x)")).toEqual([]);
});

test("handles real captured commands without false positives", () => {
  // Pipelines and git plumbing carry no file operands to attribute.
  expect(paths("git add -A && git commit -q -F -")).toEqual([]);
  expect(paths("bun run typecheck 2>&1 | tail -3")).toEqual([]);
  // A compound command still yields the file it wrote.
  expect(paths("cd /repo && cat > a.ts <<'EOF' && bun test")).toEqual(["write:a.ts"]);
});

// Git Bash on Windows still reads a backslash at the end of a word as an escape.
test.skipIf(process.platform !== "win32")("on Windows, a backslash inside a word separates folders and one at its end doesn't", () => {
  expect(paths("cat C:\\x\\results.csv")).toEqual(["read:C:\\x\\results.csv"]);
  expect(paths("rm -rf build\\ output")).toEqual([]);
});
