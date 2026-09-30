/**
 * Bun's bundler resolves these imports; TypeScript needs telling they exist.
 * A CSS import is a side effect — the bundler emits a stylesheet and links it
 * from the generated HTML — and an HTML import is the served route.
 */
declare module "*.css";
declare module "*.html" {
  const route: unknown;
  export default route;
}

/**
 * ELK's worker, imported with `type: "file"` so the bundler embeds it. What
 * arrives is a path the runtime can hand to `new Worker`, including the
 * virtual path inside a compiled binary.
 */
declare module "elkjs/lib/elk-worker.min.js" {
  const path: string;
  export default path;
}
