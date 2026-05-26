/**
 * Lightweight test — the IDB layer needs a fake-indexeddb env to actually exercise
 * append/recent. For Phase A we sanity-check the pure ACTION_TO_PILLAR mapping.
 */
import { ACTION_TO_PILLAR } from '../src/action-log';

describe('action-log.ACTION_TO_PILLAR', () => {
  it('maps every ActionType to a pillar', () => {
    expect(ACTION_TO_PILLAR.comment).toBe('engaging');
    expect(ACTION_TO_PILLAR.post).toBe('brand');
    expect(ACTION_TO_PILLAR.invite).toBe('finding');
    expect(ACTION_TO_PILLAR.thread_reply).toBe('building');
    expect(ACTION_TO_PILLAR.like).toBe('engaging');
  });
});
