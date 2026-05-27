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

/** Full LinkedIn profile + activity snapshot. Issue #16. */
export interface UserProfile {
  capturedAt: string;
  profileUrl: string;
  name: string;
  headline: string;
  location?: string;
  connectionsCount?: number;
  followersCount?: number;
  about?: string;
  skills: string[];
  experience: Array<{
    company: string;
    title: string;
    dateRange: string;
    location?: string;
    description?: string;
  }>;
  education: Array<{
    school: string;
    degree?: string;
    field?: string;
    dateRange?: string;
  }>;
  certifications?: Array<{
    name: string;
    issuer?: string;
    date?: string;
  }>;
  languages?: string[];
  recentPosts: Array<{
    id: string;
    text: string;
    timestamp: string;
    engagement?: { likes: number; comments: number; reposts: number };
    isRepost: boolean;
  }>;
  recentComments: Array<{
    id: string;
    text: string;
    timestamp: string;
    originalPostText: string;
    originalAuthor: string;
  }>;
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
  userProfile: {
    key: string;
    value: UserProfile;
  };
}

const DB_NAME = 'linkmate';
const DB_VERSION = 2;

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
        if (oldVersion < 2) {
          db.createObjectStore('userProfile');
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
