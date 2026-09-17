/** Prompt builders for the two-stage release-notes classification pipeline. */

function formatCommitForStage1(commit) {
  const lines = [`Commit: ${commit.hash}`, `Subject: ${commit.subject}`];
  if (commit.body) lines.push(`Body:\n${commit.body}`);
  if (commit.diff) lines.push(`Diff:\n${commit.diff}`);
  return lines.join("\n");
}

export function buildStage1Prompt(batch) {
  const commitsBlock = batch.map((c, i) => `--- Commit ${i + 1} of ${batch.length} ---\n${formatCommitForStage1(c)}`).join("\n\n");

  return `You are helping write plain-English release notes for a software product from a set of raw git commits.

For EACH commit below, classify it and write a short, non-technical, plain-English summary of what changed from a USER's point of view (not a developer's). Avoid jargon, file names, and implementation details unless there's no other way to describe the change.

Categories:
- "bugfix": fixes broken or incorrect behavior.
- "enhancement": adds a new capability or improves existing behavior in a user-visible way.
- "internal": refactors, tooling, tests, CI, dependency bumps, docs, or anything with no user-visible effect.

Also produce a short "touchpoint" (2-4 words, e.g. "sizer bot-efficiency inputs") describing what part of the product this touches, derived from the changed files/description. This is for internal grouping only, never shown to end users — keep it terse and consistent so commits about the same area use similar wording.

Return ONLY a JSON array, one object per commit, in the SAME ORDER as the commits below. Each object:
{
  "hash": "<the commit hash, echoed back exactly>",
  "category": "bugfix" | "enhancement" | "internal",
  "summary": "<plain-English, user-facing summary, one or two sentences>",
  "touchpoint": "<short internal grouping tag>"
}

Commits:

${commitsBlock}`;
}

export function buildStage2Prompt(flatList) {
  const itemsBlock = flatList
    .map((c, i) => `${i + 1}. hash=${c.hash} category=${c.category} touchpoint=${c.touchpoint ?? "—"}\n   summary: ${c.summary}`)
    .join("\n");

  return `You are consolidating a list of already-classified commits into a final release notes document for end users.

Below is a flat list of commits, each with a category (bugfix/enhancement/internal), a plain-English summary, and a short internal "touchpoint" tag. Multiple commits often describe the SAME logical change (e.g. several commits fixing the same bug, or building the same feature incrementally). Group commits that describe the same logical change into ONE entry, using the summaries and touchpoints as your grouping signal.

For each resulting entry, write:
- "name": a short, punchy title (a few words) suitable as a feature/fix name.
- "description": one or two plain-English sentences describing the change for an end user.
- "mergedHashes": the array of every commit hash (from the input list) that this entry covers.

Requirements:
- EVERY hash from the input list must appear in exactly one entry's "mergedHashes" across the whole output — do not drop any commit.
- Keep "internal" commits in the "internal" bucket unless they are clearly part of a larger bugfix/enhancement group from the other buckets — do not reclassify a commit's category, only group commits that already share a category.
- Do not invent commits or hashes that are not in the input list.

Return ONLY JSON in this exact shape:
{
  "summary": "<one short paragraph summarizing the overall release for end users>",
  "bugfixes": [ { "name": "...", "description": "...", "mergedHashes": ["..."] } ],
  "enhancements": [ { "name": "...", "description": "...", "mergedHashes": ["..."] } ],
  "internal": [ { "name": "...", "description": "...", "mergedHashes": ["..."] } ]
}

Commits:
${itemsBlock}`;
}

// Used only when Stage 2 ran as multiple chunks (large releases) — each chunk
// writes its own summary independently, so naively concatenating them reads
// as several disconnected paragraphs. This asks Gemini to rewrite them as one.
export function buildSummaryMergePrompt(chunkSummaries) {
  const summariesBlock = chunkSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return `Below are ${chunkSummaries.length} separate summaries, each describing a different slice of the SAME software release (they were written independently and may repeat themselves or overlap).

Rewrite them as ONE cohesive paragraph summarizing the release for end users — plain English, no jargon, no repetition of the same point, no "This release..." opener repeated multiple times. Keep it to 2-4 sentences covering the most notable changes across all the summaries below.

Return ONLY the merged paragraph as plain text, no JSON, no markdown, no quotes around it.

Summaries:
${summariesBlock}`;
}
