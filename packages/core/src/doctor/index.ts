/**
 * Doctor barrel (ADR-0025). Re-exports the model (T1), the read-only layer
 * (T2: `diagnose`, the assistant-agnostic scanners), and the repair
 * interpreter (T4: `applyRepairs`).
 */
export * from './diagnose';
export * from './finding';
export * from './repair';
export * from './scanners/edge-integrity';
export * from './scanners/lock';
export * from './scanners/manifest-audit';
