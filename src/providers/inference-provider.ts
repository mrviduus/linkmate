/**
 * Inference provider abstraction.
 *
 * Single interface that every backend implements (OpenAI today; Anthropic,
 * Groq, Azure-compatible proxies later). Callers in background.ts never
 * `fetch` directly — they get a provider from getActiveProvider() and
 * call .generate().
 */

export interface InferenceParams {
  /** System prompt — model behavior + persona. */
  system: string;
  /** User prompt — concrete task. */
  user: string;
  /** Max tokens to generate. Caller-controlled per task type. */
  maxTokens?: number;
  /** Temperature 0..1. Caller-controlled (e.g. 0.4 for positioning, 0.85 for drafts). */
  temperature?: number;
  /** Nucleus sampling. Default 0.9. */
  topP?: number;
  /** Stop sequences (newline boundaries etc.). */
  stop?: string[];
  /** Abort after this many milliseconds. Default 60s. */
  timeoutMs?: number;
}

export interface InferenceProvider {
  /** Human-readable name for logs + UI badges. */
  readonly name: string;
  /**
   * True iff this provider transmits inference data to a remote server.
   * UI surfaces a persistent cloud-mode warning when any active provider
   * has isCloud=true (Constitution v1.2 §I closed-list opt-in).
   */
  readonly isCloud: boolean;
  /** One-shot completion. Returns full text (already trimmed). */
  generate(params: InferenceParams): Promise<string>;
}
