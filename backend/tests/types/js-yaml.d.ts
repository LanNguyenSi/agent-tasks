// Ambient shim for T-010 round 2's workflow-yaml tests: `js-yaml` is
// already resolvable here (a transitive dev dependency of
// @eslint/eslintrc, hoisted to the workspace root node_modules; no
// runtime install needed), but this repo carries no `@types/js-yaml`, so
// `tsc` cannot find a type declaration for it. Declared narrowly (just
// `load`, the one export the new tests use) rather than pulling in the
// full upstream surface.
declare module "js-yaml" {
  export function load(input: string): unknown;
}
