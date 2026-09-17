/** Validation helpers for the two Gemini stages' structured output. */

const VALID_CATEGORIES = new Set(["bugfix", "enhancement", "internal"]);

/** Validates the Stage 1 (per-batch classification) response shape. */
export function makeStage1Validator(batchSize) {
  return (parsed) => {
    if (!Array.isArray(parsed)) return false;
    if (parsed.length !== batchSize) return false;
    return parsed.every(
      (item) =>
        item &&
        typeof item.hash === "string" &&
        typeof item.summary === "string" &&
        VALID_CATEGORIES.has(item.category),
    );
  };
}

/** Validates the Stage 2 (consolidation) response shape. */
export function validateStage2Output(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (typeof parsed.summary !== "string") return false;
  for (const bucket of ["bugfixes", "enhancements", "internal"]) {
    if (!Array.isArray(parsed[bucket])) return false;
    const valid = parsed[bucket].every(
      (entry) =>
        entry &&
        typeof entry.name === "string" &&
        typeof entry.description === "string" &&
        Array.isArray(entry.mergedHashes),
    );
    if (!valid) return false;
  }
  return true;
}
