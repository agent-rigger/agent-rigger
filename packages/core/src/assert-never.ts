/**
 * Exhaustiveness helper for switches over closed unions (e.g. Nature).
 *
 * Call this in the `default` branch of a switch over a discriminant with a
 * closed set of literal values. TypeScript narrows the switched value to
 * `never` once every member has its own `case` — passing anything else here
 * is therefore a compile error. Adding a new union member without updating
 * every such switch fails the build instead of silently falling through (or
 * returning a wrong default) at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable case: ${JSON.stringify(value)}`);
}
