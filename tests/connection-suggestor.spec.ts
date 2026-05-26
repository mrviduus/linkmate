/**
 * T402 — Connection Suggestor scaffold spec (Phase E, deferred to v0.4.1).
 * Only the export shape is verified now. Real behavior tests will land in v0.4.1.
 */

import { ConnectionSuggestor, NotImplementedError } from '../src/connection-suggestor';

describe('ConnectionSuggestor (T402 scaffold)', () => {
  it('exports the class with suggest + markDrafted methods', () => {
    const c = new ConnectionSuggestor();
    expect(typeof c.suggest).toBe('function');
    expect(typeof c.markDrafted).toBe('function');
  });

  it('suggest() throws NotImplementedError until v0.4.1', async () => {
    const c = new ConnectionSuggestor();
    await expect(c.suggest()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('markDrafted() throws NotImplementedError until v0.4.1', async () => {
    const c = new ConnectionSuggestor();
    await expect(c.markDrafted('https://example.com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  // Real behavior tests for v0.4.1 — placeholders so they appear in `jest` output
  // and remind us what needs to ship.
  it.todo('suggest() returns 5 ConnectionSuggestion records when profile captured');
  it.todo('suggest() excludes URLs already drafted this week');
  it.todo('suggest() throttles when draftedThisWeek ≥ 100 with "weekly safe limit reached" message');
  it.todo('markDrafted() increments draftedThisWeek counter and persists suggestion status');
  it.todo('markDrafted() is idempotent — re-marking the same URL does not double-count');
});
