import * as vscode from "vscode";
import { fetch as undiciFetch } from "undici";

export interface AIConfig {
  model: string;
  ollamaEndpoint: string;
}

// Use a small, fast default model available from Ollama's catalog.
const DEFAULT_MODEL = "gemma3:1b";
/** Maximum time to wait for an AI request before aborting (ms). */
const AI_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes for slow CPU-only runs

/**
 * Converts VS Code's CancellationToken and a timeout into a single AbortSignal
 * so underlying fetch/API calls are aborted on user cancel or after 30 seconds.
 * Returns { signal, cleanup } so caller can clear the timeout when the request settles.
 */
function createAbortSignalWithTimeout(token?: vscode.CancellationToken): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  const cleanup = () => clearTimeout(timeoutId);
  if (token) {
    if (token.isCancellationRequested) {
      cleanup();
      return { signal: AbortSignal.abort(), cleanup: () => { } };
    }
    token.onCancellationRequested(() => {
      cleanup();
      controller.abort();
    });
  }
  return { signal: controller.signal, cleanup };
}

/**
 * Simple Ollama-backed AI service for code explanations.
 * Always targets a local (or configured) Ollama endpoint.
 */
export class AIService {
  private readonly fetchImpl: typeof fetch = (globalThis as any).fetch
    ? (globalThis as any).fetch.bind(globalThis)
    : (undiciFetch as unknown as typeof fetch);

  private getConfig(): AIConfig {
    const config = vscode.workspace.getConfiguration("ghiaAI");
    const modelFromConfig = config.get("model");
    const model =
      typeof modelFromConfig === "string" && modelFromConfig.trim()
        ? modelFromConfig
        : DEFAULT_MODEL;
    return {
      model,
      ollamaEndpoint: config.get("ollamaEndpoint") ?? "http://89.116.212.35:11434",
    };
  }

  /**
   * Request an explanation for the given code using Ollama.
   * Throws an Error with a user-friendly message on failure (network, timeout, etc.).
   */
  async explain(
    code: string,
    lang: string,
    context?: string,
    cancellationToken?: vscode.CancellationToken,
    explainOptions?: {
      detailLevel?: "brief" | "detailed";
      fileStructure?: string;
    }
  ): Promise<string> {
    const cfg = this.getConfig();
    const prompt = this.buildPrompt(code, lang, context, explainOptions);
    const { signal, cleanup } = createAbortSignalWithTimeout(cancellationToken);

    // Resolve to an installed model before making the generate call, to avoid 404s.
    const model = await this.resolveModel(cfg.model, cfg.ollamaEndpoint, signal);
    const started = Date.now();

    try {
      const result = await this.callOllama(prompt, model, cfg.ollamaEndpoint, signal);
      cleanup();
      return result + this.formatDuration(started);
    } catch (err) {
      // Fallback: if model is missing (404), try the default model once.
      const missingModelName = this.getMissingModelName(err);
      if (missingModelName) {
        try {
          const fallbackModel = await this.pickFallbackModel(
            cfg.ollamaEndpoint,
            signal
          );
          if (fallbackModel) {
            const retry = await this.callOllama(
              prompt,
              fallbackModel,
              cfg.ollamaEndpoint,
              signal
            );
            cleanup();
            return retry;
          }
        } catch {
          // Ignore fallback failure; fall through to normal error handling.
        }
      }
      cleanup();
      if (this.isAbortError(err)) {
        return "Request was cancelled.";
      }
      const message = `${this.analyzeError(err)} (model tried: ${model}, endpoint: ${cfg.ollamaEndpoint})`;
      console.error("[ghia-ai]", err);
      throw new Error(message);
    }
  }

  /**
   * General-purpose ask endpoint: asks the model about any topic (no code extraction needed).
   */
  async ask(
    question: string,
    contextInfo?: { languageId?: string; content?: string; truncated?: boolean },
    cancellationToken?: vscode.CancellationToken
  ): Promise<string> {
    const cfg = this.getConfig();
    const contextBlock =
      contextInfo?.content && contextInfo.content.trim().length > 0
        ? `\n\nThe user is asking about the *current file* (${contextInfo.languageId ?? "unknown"}). Use this file content when answering${contextInfo.truncated ? " (truncated at the end)" : ""
        }:\n\`\`\`\n${contextInfo.content}\n\`\`\``
        : "";
    const prompt = `Explain the following concept for a Python 3 developer. Provide 2-3 concise Python 3 examples in fenced code blocks. Be clear and focused.\n\nQuestion:\n${question}\n${contextBlock}`;
    const { signal, cleanup } = createAbortSignalWithTimeout(cancellationToken);
    const model = await this.resolveModel(cfg.model, cfg.ollamaEndpoint, signal);
    const started = Date.now();
    try {
      const result = await this.callOllama(prompt, model, cfg.ollamaEndpoint, signal);
      cleanup();
      return result + this.formatDuration(started);
    } catch (err) {
      cleanup();
      const message = this.analyzeError(err);
      throw new Error(`${message} (model tried: ${model}, endpoint: ${cfg.ollamaEndpoint})`);
    }
  }

  private formatDuration(started: number): string {
    const ms = Date.now() - started;
    const s = (ms / 1000).toFixed(2);
    return `\n\n_Time: ${s}s_`;
  }

  /**
   * Returns the model name from a 404 "model not found" error, if present.
   */
  private getMissingModelName(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404/.test(message)) return null;
    const match = /model ['"]?([^'"]+)['"]? not found/i.exec(message);
    return match?.[1] ?? null;
  }

  /**
   * Query Ollama for available models and pick a fallback.
   * Prefers DEFAULT_MODEL if installed; otherwise the first model in the list.
   */
  private async pickFallbackModel(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      const base = endpoint.replace(/\/$/, "");
      const res = await this.fetchImpl(`${base}/api/tags`, {
        method: "GET",
        signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        models?: { name?: string }[];
      };
      const models = data.models
        ?.map((m) => m.name)
        .filter((n): n is string => Boolean(n));
      if (!models || models.length === 0) return null;
      if (models.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
      return models[0];
    } catch {
      return null;
    }
  }

  /**
   * Choose a model that exists locally to prevent 404s.
   * Preference order: preferred -> DEFAULT_MODEL -> first installed -> preferred (last-resort).
   */
  private async resolveModel(
    preferred: string,
    endpoint: string,
    signal?: AbortSignal
  ): Promise<string> {
    const models = await this.listModels(endpoint, signal);
    if (!models) return preferred;
    if (models.includes(preferred)) return preferred;
    if (models.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
    return models[0] ?? preferred;
  }

  /**
   * List installed models from Ollama.
   */
  private async listModels(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<string[] | null> {
    try {
      const base = endpoint.replace(/\/$/, "");
      const res = await this.fetchImpl(`${base}/api/tags`, {
        method: "GET",
        signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        models?: { name?: string }[];
      };
      return (
        data.models
          ?.map((m) => m.name)
          .filter((n): n is string => Boolean(n)) ?? null
      );
    } catch {
      return null;
    }
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
      if (error.name === "AbortError") return true;
      if (error.message?.toLowerCase().includes("aborted")) return true;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: string }).name === "AbortError"
    ) {
      return true;
    }
    return false;
  }

  /**
   * Classifies the error and returns a user-friendly message using
   * error type, status code (when present), and message patterns.
   */
  private analyzeError(error: unknown): string {
    const status = this.getStatusCode(error);
    const message = error instanceof Error ? error.message : String(error);
    const msgLower = message.toLowerCase();

    // 1. Status-code-based detection (API responses)
    if (status !== undefined) {
      if (status === 404) {
        const match = /model ['"]?([^'"]+)['"]? not found/i.exec(message);
        const modelName = match?.[1] ?? "the configured model";
        return `Model "${modelName}" is not available on your Ollama instance. Run: ollama pull ${modelName}, or set "ghiaAI.model" to a model you have.`;
      }
      if (status === 401 || status === 403) {
        return "Authentication failed (401/403). Check your Ollama instance configuration.";
      }
      if (status >= 500) {
        return "Ollama is temporarily unavailable. Try again in a few minutes.";
      }
      if (status === 429) {
        return "Rate limit exceeded. Wait a moment and try again.";
      }
      if (status >= 400 && status < 500) {
        return `Request was rejected (${status}). Check your model name and request format.`;
      }
    }

    // 2. Message-pattern detection (network, timeout, DNS, etc.)
    if (
      /econnrefused|econnreset|enotfound|network|fetch failed|failed to fetch/i.test(
        msgLower
      ) ||
      (error instanceof TypeError && msgLower.includes("fetch"))
    ) {
      return "Could not reach Ollama. Ensure it is running locally and `ghiaAI.ollamaEndpoint` is correct.";
    }
    if (/timeout|etimedout|timed out/i.test(msgLower)) {
      return "The request timed out. Check your network or try again.";
    }
    if (
      /unauthorized|invalid.*api.*key|authentication|invalid key|401|403/i.test(
        msgLower
      )
    ) {
      return "Authentication failed. Ollama typically does not require a key; check your instance config.";
    }

    // 3. Generic fallback
    const shortMessage =
      message.length > 120 ? `${message.slice(0, 117)}...` : message;
    return `Explanation failed: ${shortMessage}. Check your Ollama instance and network.`;
  }

  private getStatusCode(error: unknown): number | undefined {
    if (error == null || typeof error !== "object") return undefined;
    const o = error as Record<string, unknown>;
    if (typeof o.status === "number") return o.status;
    const res = o.response as Record<string, unknown> | undefined;
    if (res != null && typeof res.status === "number") return res.status;
    return undefined;
  }

  /**
   * Builds a prompt for the AI. When detailLevel is "detailed", asks for an in-depth
   * explanation with step-by-step breakdown, edge cases, and file-structure context.
   */
  private buildPrompt(
    code: string,
    lang: string,
    context?: string,
    options?: {
      detailLevel?: "brief" | "detailed";
      fileStructure?: string;
    }
  ): string {
    const contextBlock = context
      ? `\n\nSurrounding context (for reference only):\n\`\`\`\n${context}\n\`\`\``
      : "";
    const fileStructureBlock =
      options?.fileStructure?.trim() && options.detailLevel === "detailed"
        ? `\n\nFile structure (outline of top-level declarations in this file):\n\`\`\`\n${options.fileStructure.trim()}\n\`\`\``
        : "";

    if (options?.detailLevel === "detailed") {
      return `Explain the following ${lang} code in detail for a developer who wants to understand it deeply.

Your explanation should include:
- **What**: Clear description of what the code does (2–3 sentences)
- **Why**: Purpose and rationale; why it might be written this way
- **Step-by-step**: How the code achieves its goal (key steps or control flow)
- **Patterns & techniques**: Notable patterns, conventions, or language features used
- **Edge cases / caveats**: Any gotchas, assumptions, or things to watch for
- **Context**: How this fits with the surrounding code or file structure (use the file outline if provided)

Be thorough but organized. Use short paragraphs or bullet points. Do not repeat the code verbatim.

\`\`\`${lang}
${code}
\`\`\`${contextBlock}${fileStructureBlock}`;
    }

    return `Explain the following ${lang} code concisely.

Your explanation should:
- What: Describe what the code does in 1-2 sentences
- Why: Explain why it might exist or its purpose
- Patterns: Note any notable patterns or techniques used

Keep your explanation brief but insightful. Do not repeat the code back.

\`\`\`${lang}
${code}
\`\`\`${contextBlock}`;
  }

  private async callOllama(
    prompt: string,
    model: string,
    endpoint: string,
    signal?: AbortSignal
  ): Promise<string> {
    const base = endpoint.replace(/\/$/, "");
    const url = `${base}/api/generate`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: signal ?? undefined,
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Ollama ${res.status}: ${body || res.statusText}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json()) as { response?: string };
    const response = data.response;
    if (response == null || response === "") {
      throw new Error("No explanation was returned from Ollama.");
    }
    return response.trim();
  }
}
