/**
 * Action log domain — append-only ledger of user actions + outcome attach.
 *
 * IndexedDB-backed (via src/lib/idb.ts). Callers in background.ts wrap these
 * in message handlers (`action.log.append`, `recent7d`, `attachOutcome`).
 * Pure read/write — no UI, no scoring (that lives in cadence.ts / recommender).
 */

import { getDb, type ActionRow, type ActionType, type OutcomeRow, type Pillar } from './lib/idb';
import { tagText } from './topic-tagger';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Map an action type to its primary SSI pillar. */
export const ACTION_TO_PILLAR: Record<ActionType, Pillar> = {
  comment: 'engaging',
  post: 'brand',
  invite: 'finding',
  thread_reply: 'building',
  like: 'engaging',
};

export interface AppendInput {
  type: ActionType;
  postId?: string;
  draftText?: string;
  submitted: boolean;
  topics?: string[];
  sourceText?: string; // post body text — tagged inline if topics omitted
}

/** Append a new action row. Returns the assigned id. */
export async function append(input: AppendInput): Promise<number> {
  const db = await getDb();
  let topics = input.topics;
  if (!topics && input.sourceText) topics = tagText(input.sourceText);
  const row: ActionRow = {
    type: input.type,
    pillar: ACTION_TO_PILLAR[input.type],
    timestamp: Date.now(),
    postId: input.postId,
    draftText: input.draftText,
    submitted: input.submitted,
    topics,
  };
  return (await db.add('actions', row)) as number;
}

/** Top-N topics across submitted actions in the past `days` window. */
export async function topTopics(days = 14, n = 5): Promise<Array<{ topic: string; count: number }>> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = await getDb();
  const all = await db.getAllFromIndex('actions', 'by-ts', IDBKeyRange.lowerBound(cutoff));
  const counts: Record<string, number> = {};
  for (const a of all) {
    if (!a.submitted || !a.topics) continue;
    for (const t of a.topics) counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, n);
}

/** All actions in the rolling N-day window (default 7d), oldest first. */
export async function recent(days = 7): Promise<ActionRow[]> {
  const db = await getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const range = IDBKeyRange.lowerBound(cutoff);
  return db.getAllFromIndex('actions', 'by-ts', range);
}

export async function recent7d(): Promise<ActionRow[]> {
  return recent(7);
}

/** Actions on a specific post (any age). Used by lazy outcome attach. */
export async function getByPostId(postId: string): Promise<ActionRow[]> {
  const db = await getDb();
  const all = await db.getAll('actions');
  return all.filter((a) => a.postId === postId);
}

/** Actions submitted but with NO outcome yet — drives the "Did this work?" chip. */
export async function pendingOutcomes(olderThanMs = 24 * 60 * 60 * 1000): Promise<ActionRow[]> {
  const db = await getDb();
  const cutoff = Date.now() - olderThanMs;
  const all = await db.getAllFromIndex('actions', 'by-ts', IDBKeyRange.upperBound(cutoff));
  const outcomes = await db.getAll('outcomes');
  const actionsWithOutcome = new Set(outcomes.map((o) => o.actionId));
  return all.filter((a) => a.submitted && a.id != null && !actionsWithOutcome.has(a.id));
}

/** Attach outcome metrics to an action. Source is 'auto' (content script) or 'manual' (popup chip). */
export async function attachOutcome(input: {
  actionId: number;
  source: 'auto' | 'manual';
  likes?: number;
  replies?: number;
  manualVerdict?: 'positive' | 'negative';
}): Promise<number> {
  const db = await getDb();
  const row: OutcomeRow = {
    actionId: input.actionId,
    timestamp: Date.now(),
    likes: input.likes,
    replies: input.replies,
    source: input.source,
    manualVerdict: input.manualVerdict,
  };
  return (await db.add('outcomes', row)) as number;
}

/** Latest outcome per actionId (one action → at most one outcome row in practice). */
export async function getOutcomeForAction(actionId: number): Promise<OutcomeRow | null> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('outcomes', 'by-action', actionId);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/** Wipe everything. Settings UI "Clear history" button. */
export async function clearAll(): Promise<void> {
  const db = await getDb();
  await db.clear('actions');
  await db.clear('outcomes');
}

export { SEVEN_DAYS_MS };
