/**
 * v0.5.0 — Inference provider abstraction.
 *
 * Single interface that every model backend implements (local WebLLM, OpenAI,
 * future Anthropic/Groq/etc.). Callers in background.ts never reference
 * WebLLM or fetch directly — they get a provider from getActiveProvider()
 * and call .generate().
 *
 * Compliance gate: providers MUST self-declare via `isCloud` so the popup
 * + queue sidebar can render an honest "data leaves your browser" indicator
 * when a non-local provider is active.
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
