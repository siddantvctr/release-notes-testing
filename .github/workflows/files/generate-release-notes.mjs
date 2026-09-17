/**
 * Test harness: generates the release-notes draft for a newly tagged version
 * using Gemini, then writes it to gemini-summary.json next to this script.
 * It does NOT post the draft to apps/api — this repo only exercises the
 * Gemini generation step in isolation.
 *
 * Runs in CI after `gh release create` (see main-release.yml). Diffs commits
 * since the previous version tag, classifies + summarizes each with Gemini,
 * and consolidates near-duplicates.
 *
 * Usage:
 *   NEW_VERSION=v1.4.0 GEMINI_API_KEY=... node generate-release-notes.mjs
 *
 * Required env vars:
 *   NEW_VERSION               - the tag just created, e.g. "v1.4.0"
 *   GEMINI_API_KEY             - Gemini REST API key
 *
 * Optional:
 *   MAIN_REPO_PATH             - repo root to run git commands in (defaults to cwd)
 *   GH_TOKEN                   - used only for the total-Gemini-failure `gh release view` fallback
 *   GEMINI_MODEL                - overrides the default Gemini model
 *   PREVIOUS_VERSION            - forces an explicit range instead of auto-detecting
 *                                 the previous tag, e.g. PREVIOUS_VERSION=v0.1.0
 *                                 NEW_VERSION=v0.2.0 for v0.1.0..v0.2.0.
 */

import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  findPreviousTag,
  buildRange,
  extractCommits,
  isDescriptive,
  getCommitDiff,
} from "./release-notes/git.mjs";
import { geminiGenerateContent, withJsonRetryGemini, callLlm } from "./release-notes/gemini-client.mjs";
import { buildStage1Prompt, buildStage2Prompt, buildSummaryMergePrompt } from "./release-notes/prompts.mjs";
import { makeStage1Validator, validateStage2Output } from "./release-notes/schema.mjs";

const NEW_VERSION = process.env.NEW_VERSION;
const REPO_PATH = process.env.MAIN_REPO_PATH || process.cwd();
const STAGE1_BATCH_SIZE = 12;
const STAGE2_CHUNK_SIZE = 40;
// Local testing only: skips the createReleaseNoteDraft HTTP call (which needs
// a GitHub Actions OIDC token CI provides automatically and a local run
// can't obtain) and prints the generated draft to stdout instead.
// const DRY_RUN = process.argv.includes("--dry-run");
// Any URL identifying this repo works as the OIDC audience — GitHub just
// echoes it back into the token's `aud` claim; apps/api doesn't check it
// (it checks the `repository` claim instead), so this is not load-bearing.
// const OIDC_AUDIENCE = "https://github.com/greyorange/gsb-ng";

if (!NEW_VERSION) {
  console.error("Error: NEW_VERSION environment variable is required");
  process.exit(1);
}

// v1.0.0's release notes are the pre-existing, hand-curated FIRST_RELEASE
// bundled directly in apps/web/src/lib/first-release.ts. This pipeline never
// generates or overwrites that entry — exit immediately, no Gemini, no HTTP.
if (NEW_VERSION === "v1.0.0") {
  console.log("NEW_VERSION is v1.0.0 — skipping generated release notes (hand-curated FIRST_RELEASE covers it).");
  process.exit(0);
}

function todayFormatted() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Testing-only: this repo is used to try out the Gemini generation step in
// isolation, so instead of posting the draft to apps/api, it's dropped here
// for inspection and the pipeline stops.
const OUTPUT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(OUTPUT_DIR, "gemini-summary.json");

function writeDraftToFile(draft) {
  writeFileSync(OUTPUT_FILE, JSON.stringify(draft, null, 2));
  console.log(`[generate-release-notes] Wrote Gemini-generated draft to ${OUTPUT_FILE}`);
}

// Kept for reference (not deleted): the original apps/api-posting path.
// Disabled in this test harness in favor of writeDraftToFile() above.
//
// async function sendDraft(draft) {
//   if (DRY_RUN) {
//     console.log("\n--dry-run: not sending to the API. Generated draft:\n");
//     console.log(JSON.stringify(draft, null, 2));
//     return;
//   }
//
//   const apiUrl = process.env.API_UPSTREAM_URL;
//   if (!apiUrl) {
//     console.error("Error: API_UPSTREAM_URL environment variable is required");
//     process.exit(1);
//   }
//
//   const oidcToken = await fetchOidcToken();
//
//   const mutation = `mutation CreateReleaseNoteDraft($input: CreateReleaseNoteDraftInput!) {
//     createReleaseNoteDraft(input: $input) { id version status }
//   }`;
//
//   const res = await fetch(apiUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json", Authorization: `Bearer ${oidcToken}` },
//     body: JSON.stringify({ query: mutation, variables: { input: draft } }),
//   });
//
//   const json = await res.json().catch(() => null);
//
//   if (!res.ok || json?.errors) {
//     console.error("createReleaseNoteDraft failed:", res.status, JSON.stringify(json?.errors ?? (await res.text())));
//     process.exit(1);
//   }
//
//   console.log(
//     `Release note draft for ${draft.version} created/updated (status: ${json.data.createReleaseNoteDraft.status}).`,
//   );
// }
//
// async function fetchOidcToken() {
//   const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
//   const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
//   if (!url || !requestToken) {
//     throw new Error(
//       "ACTIONS_ID_TOKEN_REQUEST_URL/ACTIONS_ID_TOKEN_REQUEST_TOKEN not set — does this job have `permissions: id-token: write`?",
//     );
//   }
//
//   const res = await fetch(`${url}&audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
//     headers: { Authorization: `Bearer ${requestToken}` },
//   });
//   if (!res.ok) {
//     throw new Error(`Failed to fetch GitHub OIDC token: ${res.status} ${await res.text().catch(() => "")}`);
//   }
//   const data = await res.json();
//   return data.value;
// }

/** Total-Gemini-failure fallback: GitHub's own auto-generated changelog body. */
function fallbackToGhReleaseBody() {
  console.warn("[generate-release-notes] Falling back to `gh release view --json body`.");
  const body = execFileSync("gh", ["release", "view", NEW_VERSION, "--json", "body", "--jq", ".body"], {
    cwd: REPO_PATH,
    encoding: "utf8",
  }).trim();

  return { version: NEW_VERSION, date: todayFormatted(), body };
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

async function runStage1(commits) {
  const batches = chunk(commits, STAGE1_BATCH_SIZE);
  const flatList = [];

  for (const batch of batches) {
    const result = await withJsonRetryGemini({
      modelCallFn: () =>
        geminiGenerateContent({
          prompt: buildStage1Prompt(batch),
          temperature: 0.2,
          responseMimeType: "application/json",
        }),
      parseFn: (text) => JSON.parse(text),
      validateFn: makeStage1Validator(batch.length),
      fallbackCallFn: (correction) => callLlm(correction),
      agentName: "release-notes-stage1",
    });

    if (!result) {
      // Total batch failure (all retries exhausted) — degrade to synthetic
      // internal entries rather than aborting the whole pipeline.
      console.warn(`[generate-release-notes] Stage 1 batch failed entirely; degrading ${batch.length} commit(s) to "internal".`);
      for (const commit of batch) {
        flatList.push({ hash: commit.hash, category: "internal", summary: commit.subject, touchpoint: null });
      }
      continue;
    }

    flatList.push(...result);
  }

  return flatList;
}

async function runStage2Chunk(flatListChunk) {
  return withJsonRetryGemini({
    modelCallFn: () =>
      geminiGenerateContent({
        prompt: buildStage2Prompt(flatListChunk),
        temperature: 0.2,
        responseMimeType: "application/json",
        // Consolidated entries (name + description + mergedHashes[]) are far
        // more verbose per-item than Stage 1's output — the 8192-token default
        // was empirically observed truncating mid-response on a 60-item chunk
        // (real test: v0.1.0..v0.2.0, 105 commits). Raised with headroom.
        maxOutputTokens: 16384,
      }),
    parseFn: (text) => JSON.parse(text),
    validateFn: validateStage2Output,
    fallbackCallFn: (correction) => callLlm(correction),
    agentName: "release-notes-stage2",
  });
}

/**
 * When Stage 2 ran as multiple chunks, each chunk wrote its own summary
 * independently — naively concatenating them reads as several disconnected
 * paragraphs. This makes one extra plain-text Gemini call to rewrite them as
 * a single cohesive overview. Best-effort: if it fails for any reason, falls
 * back to the naive join rather than failing the whole pipeline over a
 * cosmetic issue — the structural data (features, bug fixes) already succeeded.
 */
async function mergeSummaries(chunkSummaries) {
  try {
    const merged = await geminiGenerateContent({
      prompt: buildSummaryMergePrompt(chunkSummaries),
      temperature: 0.3,
      responseMimeType: null,
    });
    const text = merged?.trim();
    return text || chunkSummaries.join(" ");
  } catch (err) {
    console.warn(`[generate-release-notes] Summary merge failed, falling back to concatenation: ${err.message}`);
    return chunkSummaries.join(" ");
  }
}

/**
 * Stage 2 runs over the full flat list at once so cross-batch dedup is
 * possible. Above STAGE2_CHUNK_SIZE entries, map-reduces over chunks instead —
 * cross-chunk dedup isn't guaranteed at that scale (documented limitation),
 * but every commit is still guaranteed to be accounted for somewhere by the
 * completeness enforcement pass below.
 */
async function runStage2(flatList) {
  const chunks = chunk(flatList, STAGE2_CHUNK_SIZE);
  const results = [];
  for (const c of chunks) {
    const result = await runStage2Chunk(c);
    if (!result) return null; // total failure — let the caller trigger the gh-release fallback
    results.push(result);
  }

  if (results.length === 1) return results[0];

  // Merge chunk outputs. No cross-chunk consolidation of near-duplicates —
  // each chunk's grouping stands on its own.
  return {
    summary: await mergeSummaries(results.map((r) => r.summary)),
    bugfixes: results.flatMap((r) => r.bugfixes),
    enhancements: results.flatMap((r) => r.enhancements),
    internal: results.flatMap((r) => r.internal),
  };
}

/**
 * Hard local completeness check: every extracted commit hash must appear in
 * exactly one bucket's mergedHashes. Anything Stage 2 (or a dropped Stage 1
 * batch) missed gets a synthetic entry appended, built from its Stage 1
 * summary/category when available, or the raw commit subject otherwise. This
 * is what makes "no commit left out" a guarantee, not a probability.
 */
function enforceCompleteness(consolidated, commits, stage1FlatList) {
  const stage1ByHash = new Map(stage1FlatList.map((s) => [s.hash, s]));
  const covered = new Set();
  for (const bucket of ["bugfixes", "enhancements", "internal"]) {
    for (const entry of consolidated[bucket]) {
      for (const hash of entry.mergedHashes) covered.add(hash);
    }
  }

  for (const commit of commits) {
    if (covered.has(commit.hash)) continue;

    const stage1Entry = stage1ByHash.get(commit.hash);
    const category = stage1Entry?.category ?? "internal";
    const bucket = category === "bugfix" ? "bugfixes" : category === "enhancement" ? "enhancements" : "internal";

    consolidated[bucket].push({
      name: commit.subject,
      description: stage1Entry?.summary ?? commit.subject,
      mergedHashes: [commit.hash],
    });
    console.warn(`[generate-release-notes] Commit ${commit.hash} was not covered by Stage 2 — added as a fallback entry.`);
  }

  return consolidated;
}

function shapeDraft(consolidated) {
  const toFeature = (entry, classification, included) => ({
    name: entry.name,
    description: entry.description,
    classification,
    included,
    commitShas: entry.mergedHashes,
  });

  const sections = [
    {
      title: "New Features/Enhancements",
      features: consolidated.enhancements.map((e) => toFeature(e, "enhancement", true)),
    },
    {
      title: "Bug Fixes",
      features: consolidated.bugfixes.map((e) => toFeature(e, "bugfix", true)),
    },
  ].filter((section) => section.features.length > 0);

  const internalItems = consolidated.internal.map((e) => toFeature(e, "internal", false));

  return {
    version: NEW_VERSION,
    date: todayFormatted(),
    summary: consolidated.summary,
    sections,
    internalItems,
  };
}

async function main() {
  // Testing aid: normally the previous tag is always auto-detected (the real
  // workflow must never guess wrong), but a local dry run may want to force
  // an explicit range instead — e.g. comparing v0.1.0..v0.2.0 directly rather
  // than whatever tag actually shipped immediately before v0.2.0.
  const previousTag = process.env.PREVIOUS_VERSION || findPreviousTag(NEW_VERSION, REPO_PATH);
  const range = buildRange(previousTag, NEW_VERSION);
  console.log(`[generate-release-notes] Diffing range: ${range}`);

  const commits = extractCommits(range, REPO_PATH);
  console.log(`[generate-release-notes] Found ${commits.length} non-merge commit(s).`);

  if (commits.length === 0) {
    writeDraftToFile({
      version: NEW_VERSION,
      date: todayFormatted(),
      summary: "No user-facing changes in this release.",
      sections: [],
    });
    return;
  }

  // Title -> body -> diff fallback chain for under-described commits.
  for (const commit of commits) {
    if (!isDescriptive(commit.subject, commit.body)) {
      try {
        commit.diff = getCommitDiff(commit.hash, REPO_PATH);
      } catch (err) {
        console.warn(`[generate-release-notes] Could not get diff for ${commit.hash}: ${err.message}`);
      }
    }
  }

  const stage1FlatList = await runStage1(commits);
  const stage2Result = await runStage2(stage1FlatList);

  if (!stage2Result) {
    console.error("[generate-release-notes] Stage 2 failed entirely.");
    writeDraftToFile(fallbackToGhReleaseBody());
    return;
  }

  const consolidated = enforceCompleteness(stage2Result, commits, stage1FlatList);
  const draft = shapeDraft(consolidated);
  writeDraftToFile(draft);
}

main().catch((err) => {
  console.error("[generate-release-notes] Failed:", err);
  process.exit(1);
});
