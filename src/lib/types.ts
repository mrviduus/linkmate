export type SsiSample = {
  date: string; // YYYY-MM-DD
  total: number; // 0-100
  brand: number; // 0-25
  finding: number; // 0-25
  engaging: number; // 0-25
  building: number; // 0-25
};

export type DailyTargets = {
  likes: number;
  comments: number;
  posts: number;
  courses: number;
};

export type DailyProgress = {
  date: string;
  likes: number;
  comments: number;
  posts: number;
  courses: number;
};

export type ProfileAudit = {
  score: number;
  missing: string[];
  lastRun: string;
};

export type Settings = {
  openaiApiKey: string;
  model: string;
};

export type StoreShape = {
  ssiHistory: SsiSample[];
  dailyTargets: DailyTargets;
  dailyProgress: DailyProgress;
  profileAudit: ProfileAudit | null;
  settings: Settings;
};

export type Msg =
  | { type: 'SSI_SAVED'; sample: SsiSample }
  | { type: 'PROFILE_AUDIT_SAVED'; audit: ProfileAudit }
  | { type: 'DRAFT_COMMENTS'; postAuthor: string; postBody: string }
  | { type: 'DRAFT_COMMENTS_RESULT'; drafts: string[]; error?: string };
