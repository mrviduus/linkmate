/**
 * T401 — Connection Suggestor scaffold (Phase E, US4, deferred to v0.4.1).
 *
 * v0.4.0 ships ONLY the class skeleton + types. Full UI lands in v0.4.1.
 *
 * Why scaffold now: keeps `ConnectionSuggestion` storage helpers and the
 * weekly-cap counter exercised by tests so the v0.4.1 work is contained.
 * Methods throw NotImplementedError; tests use `it.todo` markers.
 */

import type { ConnectionSuggestion } from './storage-schema';

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`ConnectionSuggestor.${method}() is scaffolded but not implemented until v0.4.1`);
    this.name = 'NotImplementedError';
  }
}

export class ConnectionSuggestor {
  /**
   * Surface 5 suggestions per weekday morning. Will pull from a configurable
   * list of target search queries (e.g. "AI Engineer hiring Toronto"),
   * deduplicate against `linkmate.connections.suggestions.v1` history, and
   * generate a personalized note via WebLLM for each.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async suggest(_args?: { count?: number }): Promise<ConnectionSuggestion[]> {
    throw new NotImplementedError('suggest');
  }

  /**
   * Mark a suggestion as drafted (user clicked Copy note & open profile).
   * Increments `linkmate.connections.draftedThisWeek.v1` and excludes the
   * profileUrl from tomorrow's batch.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async markDrafted(_profileUrl: string): Promise<void> {
    throw new NotImplementedError('markDrafted');
  }
}
