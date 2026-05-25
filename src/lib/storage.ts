import type {
  DailyProgress,
  DailyTargets,
  ProfileAudit,
  Settings,
  SsiSample,
  StoreShape,
} from './types';

export const todayISO = () => new Date().toISOString().slice(0, 10);

const DEFAULTS: StoreShape = {
  ssiHistory: [],
  dailyTargets: { likes: 5, comments: 3, posts: 0, courses: 0 },
  dailyProgress: { date: todayISO(), likes: 0, comments: 0, posts: 0, courses: 0 },
  profileAudit: null,
  settings: { openaiApiKey: '', model: 'gpt-4o-mini' },
};

export async function getAll(): Promise<StoreShape> {
  const raw = await chrome.storage.local.get(DEFAULTS);
  return raw as StoreShape;
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get({ settings: DEFAULTS.settings });
  return settings as Settings;
}

export async function setSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}

export async function getHistory(): Promise<SsiSample[]> {
  const { ssiHistory } = await chrome.storage.local.get({ ssiHistory: [] });
  return ssiHistory as SsiSample[];
}

export async function appendSsi(sample: SsiSample): Promise<SsiSample[]> {
  const history = await getHistory();
  const filtered = history.filter((s) => s.date !== sample.date);
  const next = [...filtered, sample].sort((a, b) => a.date.localeCompare(b.date));
  await chrome.storage.local.set({ ssiHistory: next });
  return next;
}

export async function getTargets(): Promise<DailyTargets> {
  const { dailyTargets } = await chrome.storage.local.get({
    dailyTargets: DEFAULTS.dailyTargets,
  });
  return dailyTargets as DailyTargets;
}

export async function setTargets(t: DailyTargets): Promise<void> {
  await chrome.storage.local.set({ dailyTargets: t });
}

export async function getProgress(): Promise<DailyProgress> {
  const { dailyProgress } = await chrome.storage.local.get({
    dailyProgress: { ...DEFAULTS.dailyProgress, date: todayISO() },
  });
  const p = dailyProgress as DailyProgress;
  if (p.date !== todayISO()) {
    const reset = { date: todayISO(), likes: 0, comments: 0, posts: 0, courses: 0 };
    await chrome.storage.local.set({ dailyProgress: reset });
    return reset;
  }
  return p;
}

export async function bumpProgress(key: keyof Omit<DailyProgress, 'date'>): Promise<DailyProgress> {
  const p = await getProgress();
  const next = { ...p, [key]: p[key] + 1 };
  await chrome.storage.local.set({ dailyProgress: next });
  return next;
}

export async function setProfileAudit(a: ProfileAudit): Promise<void> {
  await chrome.storage.local.set({ profileAudit: a });
}

/** weakest pillar of latest sample, used to bias daily targets */
export function weakestPillar(s: SsiSample): keyof Omit<SsiSample, 'date' | 'total'> {
  const pillars: (keyof Omit<SsiSample, 'date' | 'total'>)[] = ['brand', 'finding', 'engaging', 'building'];
  return pillars.reduce((min, p) => (s[p] < s[min] ? p : min), pillars[0]);
}

/** Targets biased by weakest SSI pillar — pillar -> action that nudges it. */
export function tunedTargets(base: DailyTargets, latest: SsiSample | undefined): DailyTargets {
  if (!latest) return base;
  const w = weakestPillar(latest);
  const bumped = { ...base };
  if (w === 'brand') bumped.posts = Math.max(bumped.posts, 1);
  if (w === 'finding') bumped.likes = bumped.likes + 3;
  if (w === 'engaging') bumped.comments = bumped.comments + 2;
  if (w === 'building') bumped.likes = bumped.likes + 2;
  return bumped;
}
