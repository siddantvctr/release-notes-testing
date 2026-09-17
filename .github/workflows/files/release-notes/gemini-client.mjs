/**
 * Gemini client + JSON self-correction retry.
 * Ported from apps/solution-catalog/lib/catalog/gemini.js (not imported — no
 * workspace linking between apps/api and apps/solution-catalog), dropping the
 * catalog-specific helpers (catalogLlmModelName/catalogLlmDisplayName/
 * isLlmCitationSource) in favor of a small resolveModel() reading GEMINI_MODEL.
 */

const DEFAULT_MODEL = "gemini-3.6-flash";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

export function resolveModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

// ── JSON extraction / repair ────────────────────────────────────────────────

function repairTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escapeNext = false;
  let lastSafePos = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      if (!inString) lastSafePos = i + 1;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" && stack.length && stack[stack.length - 1] === "{") {
      stack.pop();
      lastSafePos = i + 1;
    } else if (ch === "]" && stack.length && stack[stack.length - 1] === "[") {
      stack.pop();
      lastSafePos = i + 1;
    }
  }

  if (!stack.length) return null;

  const closing = stack
    .slice()
    .reverse()
    .map((c) => (c === "{" ? "}" : "]"))
    .join("");
  const repaired = text.slice(0, lastSafePos) + closing;
  try {
    return JSON.parse(repaired);
  } catch (_) {
    return null;
  }
}

export function extractJsonFromText(text) {
  if (!text) return null;

  let stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/gm, "")
    .replace(/```\s*$/gm, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {
    // continue
  }

  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      // continue
    }
  }

  const repaired = repairTruncatedJson(stripped);
  if (repaired !== null) return repaired;

  const lastBrace = stripped.lastIndexOf("}");
  if (lastBrace !== -1) {
    const candidate = stripped.slice(0, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // continue
    }
  }

  return null;
}

// ── Gemini REST call ─────────────────────────────────────────────────────────

function extractResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

export async function geminiGenerateContent({
  prompt,
  temperature = 0.1,
  maxOutputTokens = 8192,
  responseMimeType = "application/json",
  model,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const resolvedModel = model || resolveModel();

  const generationConfig = { temperature, maxOutputTokens };
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;

  const res = await fetch(`${API_ROOT}/${resolvedModel}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return extractResponseText(data);
}

/** Plain-text (non-constrained) call, used for the JSON self-correction fallback. */
export async function callLlm(prompt, { temperature = 0.3 } = {}) {
  try {
    return await geminiGenerateContent({
      prompt,
      temperature,
      maxOutputTokens: 4096,
      responseMimeType: null,
    });
  } catch (e) {
    console.warn("[LLMClient] LLM call failed:", e.message);
    return null;
  }
}

function correctionPrompt(originalPrompt, brokenOutput, error) {
  return `Your previous response contained invalid JSON. Here is the error:

ERROR: ${error}

YOUR BROKEN OUTPUT:
${(brokenOutput || "").slice(0, 2000)}

Please fix the JSON and return ONLY valid JSON that matches the required schema.
Do not add any explanation, markdown fences, or text before/after the JSON.

Original task:
${(originalPrompt || "").slice(0, 1500)}`;
}

/** Retry wrapper for Gemini structured-output calls. */
export async function withJsonRetryGemini({
  modelCallFn,
  parseFn,
  validateFn = null,
  fallbackCallFn = null,
  maxAttempts = 3,
  agentName = "gemini-agent",
}) {
  let lastError = null;
  let lastRaw = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const rawText = await modelCallFn();
      let parsed = null;
      try {
        parsed = parseFn(rawText);
        if (parsed === null || parsed === undefined) {
          const recovered = extractJsonFromText(rawText || "");
          if (recovered !== null) parsed = recovered;
        }
      } catch (parseErr) {
        const recovered = extractJsonFromText(rawText || "");
        if (recovered !== null) parsed = recovered;
        if (parsed === null || parsed === undefined) throw parseErr;
      }

      if (parsed === null || parsed === undefined) {
        lastError = "Could not extract a JSON object from the LLM response";
        continue;
      }

      lastRaw = JSON.stringify(parsed);

      if (validateFn && !validateFn(parsed)) {
        lastError = "Structured output failed validation";
        console.warn(`[${agentName}] Attempt ${attempt}/${maxAttempts}: validation failed`);
        continue;
      }

      return parsed;
    } catch (e) {
      lastError = e.message || String(e);
      console.warn(`[${agentName}] Attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
    }
  }

  if (fallbackCallFn && lastRaw) {
    try {
      const correction = correctionPrompt(
        "Correct the JSON and return only valid JSON matching the original schema.",
        lastRaw,
        lastError || "Unknown error",
      );
      const raw = await fallbackCallFn(correction, lastError || "");
      if (raw) {
        const parsed = extractJsonFromText(raw);
        if (parsed && (validateFn === null || validateFn(parsed))) {
          console.info(`[${agentName}] Fallback unstructured call succeeded`);
          return parsed;
        }
      }
    } catch (fe) {
      console.error(`[${agentName}] Fallback call also failed: ${fe.message}`);
    }
  }

  console.error(`[${agentName}] All ${maxAttempts} attempts failed. Last error: ${lastError}`);
  return null;
}
