/**
 * Git helpers for the release-notes generator: finding the previous version
 * tag, extracting the commit range as structured data, and falling back to a
 * per-commit diff when the commit message alone isn't descriptive enough.
 */

import { execFileSync } from "child_process";

const COMMIT_SEP = "§§COMMIT§§"; // §§COMMIT§§
const FIELD_SEP = "§§F§§"; // §§F§§
const END_SEP = "§§END§§"; // §§END§§

const LOCKFILE_AND_BINARY_EXCLUDES = [
  ":!*.lock",
  ":!package-lock.json",
  ":!yarn.lock",
  ":!pnpm-lock.yaml",
  ":!*.svg",
  ":!*.png",
  ":!*.jpg",
  ":!*.jpeg",
  ":!*.woff*",
  ":!*.ico",
];

const LOW_SIGNAL_SUBJECT = /^(wip|fix|fixup!|squash!|temp|tmp|minor|update|misc|stuff|checkpoint|cleanup|\.)$/i;
const DIFF_CHAR_CAP = 8000;
const TRUNCATION_MARKER = "\n\n[... diff truncated ...]";

function run(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

/**
 * Finds the previous version tag on `main`, strictly matching vX.Y.Z, excluding
 * NEW_VERSION itself. Returns null when there's no earlier tag (first-ever run).
 */
export function findPreviousTag(newVersion, cwd) {
  const output = run(
    ["tag", "--list", "v*", "--merged", "main", "--sort=-version:refname"],
    cwd,
  );
  const tags = output
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .filter((t) => t !== newVersion);

  return tags[0] ?? null;
}

/** Builds the `git log` commit range spec for the given previous tag / new version. */
export function buildRange(previousTag, newVersion) {
  return previousTag ? `${previousTag}..${newVersion}` : newVersion;
}

/** Extracts { hash, subject, body }[] for every non-merge commit in the range. */
export function extractCommits(range, cwd) {
  let output;
  try {
    output = run(
      ["log", range, "--no-merges", `--pretty=format:${COMMIT_SEP}%n%H${FIELD_SEP}%s${FIELD_SEP}%b${END_SEP}`],
      cwd,
    );
  } catch (err) {
    throw new Error(`git log failed for range "${range}": ${err.message}`);
  }

  if (!output.trim()) return [];

  return output
    .split(COMMIT_SEP)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const withoutEnd = chunk.endsWith(END_SEP) ? chunk.slice(0, -END_SEP.length) : chunk;
      const [hash, subject = "", ...bodyParts] = withoutEnd.split(FIELD_SEP);
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: bodyParts.join(FIELD_SEP).trim(),
      };
    })
    .filter((c) => c.hash);
}

/**
 * A commit is "descriptive enough" unless its subject is a known low-signal
 * placeholder, or the combined title+body is under ~4 words.
 */
export function isDescriptive(subject, body) {
  const trimmedSubject = (subject || "").trim();
  if (LOW_SIGNAL_SUBJECT.test(trimmedSubject)) return false;

  const combined = `${trimmedSubject} ${(body || "").trim()}`.trim();
  const wordCount = combined.split(/\s+/).filter(Boolean).length;
  return wordCount >= 4;
}

/**
 * Diff fallback for non-descriptive commits: `--stat` is always included in
 * full (cheap signal, kept intact even when the patch is cut); the diff patch
 * itself is hard-capped at 8000 chars with a truncation marker.
 */
export function getCommitDiff(hash, cwd) {
  const stat = run(
    ["show", hash, "--no-color", "--stat", "--format=", "--", ".", ...LOCKFILE_AND_BINARY_EXCLUDES],
    cwd,
  ).trim();

  let patch = run(
    ["show", hash, "--no-color", "--unified=3", "--format=", "--", ".", ...LOCKFILE_AND_BINARY_EXCLUDES],
    cwd,
  ).trim();

  if (patch.length > DIFF_CHAR_CAP) {
    patch = patch.slice(0, DIFF_CHAR_CAP) + TRUNCATION_MARKER;
  }

  return [stat, patch].filter(Boolean).join("\n\n");
}
