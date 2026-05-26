/**
 * Thin IndexedDB wrapper for LinkMate's time-series stores.
 *
 * Wraps the `idb` package (~1KB) so callers in action-log.ts / cadence.ts
 * never touch the raw IDB API. Two object stores:
 *   - `actions`  : append-only ledger of user actions (autoinc id, idx on type+timestamp)
 *   - `outcomes` : engagement metrics attached 24h+ later, FK to action.id
 *
 * Schema version increments + migrations run inside `getDb()`. Storage keys
 * outside IDB (settings, profile, SSI) stay on chrome.storage.local.
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb';

export type ActionType = 'comment' | 'post' | 'invite' | 'thread_reply' | 'like';

/** Coarse pillar tag — recommender bins by this. */
export type Pillar = 'brand' | 'finding' | 'engaging' | 'building';

export interface ActionRow {
  id?: number;
  type: ActionType;
  pillar: Pillar;
  timestamp: number; // ms epoch
  postId?: string;
  draftText?: string;
  submitted: boolean; // false if drafted but never sent
  topics?: string[]; // populated by topic-tagger at append time (Phase B)
  // Manual chip (👍/👎) is stored on the outcome row, not here.
}

export interface OutcomeRow {
  id?: number;
  actionId: number;
  timestamp: number;
  likes?: number;
  replies?: number;
  source: 'auto' | 'manual';
  manualVerdict?: 'positive' | 'negative';
}

interface LinkMateDB extends DBSchema {
  actions: {
    key: number;
    value: ActionRow;
    indexes: { 'by-type-ts': [ActionType, number]; 'by-ts': number };
  };
  outcomes: {
    key: number;
    value: OutcomeRow;
    indexes: { 'by-action': number };
  };
}

const DB_NAME = 'linkmate';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<LinkMateDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<LinkMateDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LinkMateDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const actions = db.createObjectStore('actions', {
            keyPath: 'id',
            autoIncrement: true,
          });
          actions.createIndex('by-type-ts', ['type', 'timestamp']);
          actions.createIndex('by-ts', 'timestamp');
          const outcomes = db.createObjectStore('outcomes', {
            keyPath: 'id',
            autoIncrement: true,
          });
          outcomes.createIndex('by-action', 'actionId');
        }
      },
    });
  }
  return dbPromise;
}

/** Test/reset hook — drops the singleton so the next getDb() reopens. */
export function _resetDbSingleton(): void {
  dbPromise = null;
}
