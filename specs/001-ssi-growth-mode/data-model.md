# Data Model — SSI Growth Mode (v0.4.0)

**Source of truth:** `src/storage-schema.ts` — entity types and storage helpers.
**Schema version:** 1 (constant `SCHEMA_VERSION` in storage-schema.ts).
**Migration:** `migrateIfNeeded()` runs on background startup; bumps `linkmate.schema.version`.

This file is a reference extract. When entity types or storage keys change, edit `storage-schema.ts` first, then update this document.

---

## Storage Layout

All keys live under `chrome.storage.local`. v0.3.x keys under `chrome.storage.sync` are unchanged and untouched by this feature.

| Key                                        | Type                    | Purpose                                                  | Eviction                       |
|--------------------------------------------|-------------------------|----------------------------------------------------------|--------------------------------|
| `linkmate.profile.v1`                     | `ProfileContext`        | Captured user profile + positioning summary              | Manual; stale chip after 30d   |
| `linkmate.queue.engaged.v1`               | `EngagedPost[]`         | Posts the user has copied a draft for                    | TTL filter (30d) on read       |
| `linkmate.queue.dismissed.v1`             | `string[]`              | Post IDs the user explicitly hid                         | Forever (until manual clear)   |
| `linkmate.queue.preferences.v1`           | `QueuePreferences`      | defaultTone, defaultLength, autoRefreshMinutes, sidebar  | Forever (write deferred)       |
| `linkmate.ssi.history.v1`                 | `SsiSnapshot[]`         | Daily SSI snapshots                                      | FIFO, cap 90                   |
| `linkmate.ssi.lastError.v1`               | `SsiLastError`          | Last parse/capture failure for popup chip                | Cleared on next success        |
| `linkmate.connections.suggestions.v1`     | `ConnectionSuggestion[]`| Today's connection suggestions (v0.4.1)                  | Daily refresh, 7d history      |
| `linkmate.connections.draftedThisWeek.v1` | `number`                | Counter for safe-limit throttle (v0.4.1)                 | Resets Monday 00:00 UTC        |
| `linkmate.schema.version`                 | `number`                | Migration anchor                                         | Bump on breaking change        |

## Constants

| Constant                 | Value                  | Used by                                        |
|--------------------------|------------------------|------------------------------------------------|
| `SCHEMA_VERSION`         | `1`                    | `migrateIfNeeded`                              |
| `MAX_SSI_SNAPSHOTS`      | `90`                   | `appendSsiSnapshot` eviction                   |
| `ENGAGED_POST_TTL_MS`    | `30 * 24 * 60 * 60 * 1000` (30 days) | `markEngaged` expiresAt, `getEngagedPosts` filter |
| `QUEUE_REFRESH_THROTTLE_MS` | `5 * 60 * 1000` (5 min) | `EngagementQueue.refresh`                |
| `QUEUE_MAX_VISIBLE`      | `10`                   | `EngagementQueue` render cap                   |
| `SSI_CAPTURE_TIMEOUT_MS` | `30_000`               | `startSsiCapture` (background.ts)              |

---

## Entity Types

### ProfileContext
```typescript
{
  fullName: string;
  headline: string;
  about: string;                  // truncated to 1500 chars by parser
  topSkills: string[];            // max 10 items
  recentPostThemes: string[];     // max 5 items
  positioningSummary: string;     // 2-sentence LLM-generated; injected into every draft prompt
  capturedAt: number;             // ms epoch
}
```

### ParsedPost
One LinkedIn feed post extracted from DOM. `degree` and `followerTier` feed the relevance scorer.
```typescript
{
  id: string;                     // urn:li:activity:<digits>
  authorUrn: string;              // urn:li:profile:<handle>
  authorName: string;
  authorTitle: string;
  followerTier: 'unknown' | 'lt_1k' | '1k_10k' | '10k_100k' | 'gt_100k';
  degree: '1st' | '2nd' | '3rd' | 'follow-only' | 'unknown';
  text: string;
  postedAt: number;               // ms epoch (parsed from "2h" / "1d" relative text)
  likeCount: number;
  commentCount: number;
  isOwn: boolean;                 // true if "You" supplementary marker present
}
```

### RelevanceScore + ScoredPost
```typescript
type ScoreCategory = 'engage_now' | 'consider' | 'skip';
type ToneKey = 'professional' | 'friendly' | 'enthusiastic' | 'thoughtful';
type LengthKey = 'brief' | 'standard' | 'detailed';

interface RelevanceScore {
  score: number;                  // 0..100, 1 decimal
  reasons: string[];              // human-readable contributing factors
  category: ScoreCategory;        // ≥70 engage_now / 40–69 consider / <40 skip
}

interface ScoredPost extends ParsedPost {
  relevance: RelevanceScore;
}
```

### DraftComment
Used in-memory by EngagementQueue; not yet persisted (will be in v0.4.1 reply history).
```typescript
{
  postId: string;
  text: string;
  tone: ToneKey;
  length: LengthKey;
  generatedAt: number;
  model: string;
}
```

### EngagedPost
Persisted under `linkmate.queue.engaged.v1`. `getEngagedPosts()` filters expired in-memory.
```typescript
{
  postId: string;
  engagedAt: number;
  expiresAt: number;              // engagedAt + ENGAGED_POST_TTL_MS
}
```

### SsiSnapshot
Persisted under `linkmate.ssi.history.v1`.
```typescript
{
  total: number;                  // 0..100
  components: {
    establishBrand: number;       // 0..25
    findRightPeople: number;      // 0..25
    engageWithInsights: number;   // 0..25
    buildRelationships: number;   // 0..25
  };
  industryRank: string;           // raw text e.g. "You rank in the top 80% of your industry."
  networkRank: string;
  capturedAt: number;
}
```

### SsiLastError
Persisted under `linkmate.ssi.lastError.v1`; surfaces as popup chip until next success.
```typescript
{
  message: string;
  capturedAt: number;
}
```

### ConnectionSuggestion (v0.4.1 scaffold)
Persisted under `linkmate.connections.suggestions.v1`.
```typescript
{
  profileUrl: string;
  name: string;
  title: string;
  company: string;
  personalizedNote: string;       // ≤300 chars (LinkedIn note cap)
  suggestedAt: number;
  status: 'pending' | 'drafted' | 'skipped';
}
```

### QueuePreferences
Persisted under `linkmate.queue.preferences.v1`. `sidebarPosition` write currently deferred.
```typescript
{
  defaultTone: ToneKey;
  defaultLength: LengthKey;
  autoRefreshMinutes: number;
  sidebarPosition: { top: number; right: number };
}
```

---

## Footprint Estimate

| Item                          | Size each (≈)   | Cap | Worst case  |
|-------------------------------|-----------------|-----|-------------|
| `ProfileContext`              | 2–3 KB          | 1   | 3 KB        |
| `EngagedPost`                 | ~60 B           | ~250 (active 30d window assuming ~8/day) | 15 KB |
| `dismissedPostIds` string     | ~30 B           | unbounded; expect <500 | 15 KB |
| `SsiSnapshot`                 | ~250 B          | 90  | 22 KB       |
| `ConnectionSuggestion` (v0.4.1)| ~400 B         | 35 (5/day × 7-day history) | 14 KB |
| **Total expected**            |                 |     | **~70 KB**  |

Well under the `chrome.storage.local` 10 MB hard quota and the Constitution V 5 MB performance budget.

(Computed empirically in `tests/storage-footprint.spec.ts` — T307.)

---

## Caller Boundaries

| Surface          | Reads                                      | Writes                                     |
|------------------|--------------------------------------------|--------------------------------------------|
| background       | all keys (orchestration)                   | all keys (orchestration)                   |
| popup            | profile, ssi.history, ssi.lastError, prefs | profile (via msg → bg), prefs              |
| content scripts  | (none directly — message to background)    | (none directly — message to background)    |

Content scripts MUST NOT write storage directly. They send messages and let background mutate state. This keeps the compliance surface (Constitution I) auditable: a single grep for `chrome.storage.local.set` should show only background.ts and popup.ts callers.
