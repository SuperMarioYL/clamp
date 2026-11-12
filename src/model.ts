/**
 * Optional model assist for `clamp compile --model`.
 *
 * The model is asked for one thing: a check candidate (a regex and a file glob) given the
 * correction words and the diff. It never decides whether the candidate is acceptable —
 * that is replay's job, and the model's answer runs through the same gates as the
 * template's. Nothing here is called unless the user passes `--model`.
 */

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** DeepSeek's OpenAI-compatible endpoint; Qwen, GLM and a self-hosted vLLM speak the same shape. */
const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

/**
 * `CLAMP_MODEL_BASE_URL` / `CLAMP_MODEL_API_KEY` / `CLAMP_MODEL`. `CLAMP_BASE_URL` is
 * accepted as the shorter spelling of the endpoint.
 */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig {
  return {
    baseUrl: (env["CLAMP_MODEL_BASE_URL"] ?? env["CLAMP_BASE_URL"] ?? DEFAULT_MODEL_BASE_URL).replace(/\/+$/, ""),
    apiKey: env["CLAMP_MODEL_API_KEY"] ?? "",
    model: env["CLAMP_MODEL"] ?? DEFAULT_MODEL,
  };
}

export type CandidateSuggestion = {
  pattern: string;
  glob: string;
  claim: string;
};

export type ModelOutcome =
  | { ok: true; suggestion: CandidateSuggestion; model: string }
  | { ok: false; reason: string };

export type SuggestRequest = {
  words: string;
  /** Added and removed lines of the correction, as `git diff` would print them. */
  diff: string;
  /** The template's attempt and why replay refused it, when there is one. */
  rejected: string;
  timeoutMs?: number;
};

const SYSTEM_PROMPT = `You turn one human code-review correction into a single machine check.
Reply with one JSON object and nothing else:
{"pattern": "...", "glob": "...", "claim": "..."}
pattern: JavaScript regular expression source, no slashes, no flags. It must match the
offending code in the added lines and NONE of the removed lines, and it must still be
narrow enough that unrelated code does not match.
glob: a git pathspec glob for the files to check, naming a kind of file such as
src/**/*.ts. Never a whole directory such as src/**.
claim: one short sentence, in the language of the correction, saying what must not appear.
No prose, no markdown fences.`;

export async function suggestCandidate(config: ModelConfig, request: SuggestRequest): Promise<ModelOutcome> {
  if (config.apiKey === "") {
    return { ok: false, reason: "CLAMP_MODEL_API_KEY is not set" };
  }
  const body = {
    model: config.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `correction: ${request.words === "" ? "(none given)" : request.words}`,
          `previous attempt: ${request.rejected}`,
          "diff (+ added, - removed):",
          request.diff,
        ].join("\n"),
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeoutMs ?? 20_000),
    });
  } catch (error) {
    return { ok: false, reason: `cannot reach ${config.baseUrl}: ${errorMessage(error)}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `${config.baseUrl} answered HTTP ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, reason: `unreadable response from ${config.baseUrl}: ${errorMessage(error)}` };
  }
  const content = messageContent(payload);
  if (content === null) {
    return { ok: false, reason: "the response carried no message content" };
  }
  const parsed = firstJsonObject(content);
  if (parsed === null) {
    return { ok: false, reason: "the response was not the requested JSON object" };
  }
  const pattern = parsed["pattern"];
  const glob = parsed["glob"];
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return { ok: false, reason: "the candidate carried no pattern" };
  }
  return {
    ok: true,
    model: config.model,
    suggestion: {
      pattern: pattern.trim(),
      glob: typeof glob === "string" ? glob.trim() : "",
      claim: typeof parsed["claim"] === "string" ? parsed["claim"] : "",
    },
  };
}

function messageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices)) return null;
  const first = choices[0] as unknown;
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

/** First balanced `{…}` in the text, so a stray fence or sentence does not lose the answer. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
