'use strict';

import './popup.css';
import { Chart as ChartCtor } from './chart-loader';
import { ProfileContextService } from './profile-context';
import {
  renderLatest as renderSsiLatest,
  renderTrend as renderSsiTrend,
  getInsight as getSsiInsight,
} from './ssi-tracker';
import {
  getCaptureFullProfile,
  getProfile,
  getSsiLastError,
  setCaptureFullProfile,
  setDeepScrapeCancel,
  STORAGE_KEYS,
} from './storage-schema';
import type { DeepScrapeProgress } from './storage-schema';
import { getUserProfile } from './user-profile-store';
import type { UserProfile } from './lib/idb';
import type { ActivitySignal, ProfileContext, SsiSnapshot } from './storage-schema';

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ─── Provider (OpenAI/Groq) ───────────────────────────────────────────────────

type ProviderMode = 'managed' | 'openai' | 'groq';

interface ProviderConfigDTO {
  mode: ProviderMode;
  managed?: { model: string; baseUrl?: string };
  openai?: { apiKey: string; model: string; baseUrl?: string };
  groq?: { apiKey: string; model: string; baseUrl?: string };
}

const providerModeSelect = $<HTMLSelectElement>('providerMode');
const providerKeyField = $('providerKeyField');
const providerQuota = $('providerQuota');
const byokBanner = $('byokBanner');
const byokBannerSwitch = $<HTMLButtonElement>('byokBannerSwitch');
const providerOpenAIKeyInput = $<HTMLInputElement>('providerOpenAIKey');
const providerOpenAIModelSelect = $<HTMLSelectElement>('providerOpenAIModel');
const providerKeyHint = $('providerKeyHint');
const providerSaveBtn = $<HTMLButtonElement>('providerSave');
const providerStatus = $('providerStatus');

const DEFAULT_PROVIDER_DTO: ProviderConfigDTO = {
  mode: 'managed',
  managed: { model: 'gpt-4o-mini' },
  openai: { apiKey: '', model: 'gpt-4o-mini' },
  groq: { apiKey: '', model: 'groq/compound' },
};

let currentProviderConfig: ProviderConfigDTO = { ...DEFAULT_PROVIDER_DTO };

/** Models the managed proxy whitelists (keep in sync with proxy PRICING). */
const MANAGED_MODELS = [
  { value: 'gpt-4o-mini', text: 'gpt-4o-mini (fast, cheap)' },
  { value: 'gpt-4.1-mini', text: 'gpt-4.1-mini' },
  { value: 'gpt-4.1-nano', text: 'gpt-4.1-nano' },
];

function showProviderMessage(text: string, kind: 'success' | 'error' | 'info'): void {
  if (!providerStatus) return;
  providerStatus.textContent = text;
  providerStatus.className = `status-message ${kind}`;
  providerStatus.style.display = '';
  setTimeout(() => {
    if (providerStatus) providerStatus.style.display = 'none';
  }, 6000);
}

function updateProviderUI() {
  if (!providerModeSelect) return;
  const mode = providerModeSelect.value as ProviderMode;
  const isManaged = mode === 'managed';

  // Managed mode needs no API key — hide the key field and show the quota line.
  if (providerKeyField) providerKeyField.style.display = isManaged ? 'none' : '';
  if (providerQuota) providerQuota.style.display = isManaged ? '' : 'none';

  if (providerKeyHint) {
    providerKeyHint.textContent =
      mode === 'openai'
        ? 'Get one at platform.openai.com/api-keys'
        : 'Get one at console.groq.com/keys';
  }
  if (providerOpenAIKeyInput && !isManaged) {
    providerOpenAIKeyInput.value =
      mode === 'openai'
        ? (currentProviderConfig.openai?.apiKey ?? '')
        : (currentProviderConfig.groq?.apiKey ?? '');
    providerOpenAIKeyInput.placeholder = mode === 'openai' ? 'sk-...' : 'gsk_...';
  }
  if (providerOpenAIModelSelect) {
    providerOpenAIModelSelect.innerHTML = '';
    const models =
      mode === 'managed'
        ? MANAGED_MODELS
        : mode === 'openai'
          ? [
              { value: 'gpt-4o-mini', text: 'gpt-4o-mini (fast, cheap)' },
              { value: 'gpt-4o', text: 'gpt-4o (best quality)' },
              { value: 'gpt-4.1-mini', text: 'gpt-4.1-mini' },
              { value: 'gpt-4.1', text: 'gpt-4.1' },
              { value: 'o4-mini', text: 'o4-mini (reasoning)' },
            ]
          : [
              { value: 'groq/compound', text: 'groq/compound' },
              { value: 'groq/compound-mini', text: 'groq/compound-mini' },
              {
                value: 'meta-llama/llama-4-scout-17b-16e-instruct',
                text: 'llama-4-scout-17b-16e-instruct',
              },
            ];
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.text;
      providerOpenAIModelSelect.appendChild(opt);
    });
    const currentModel =
      mode === 'managed'
        ? currentProviderConfig.managed?.model
        : mode === 'openai'
          ? currentProviderConfig.openai?.model
          : currentProviderConfig.groq?.model;
    if (currentModel) {
      const exists = Array.from(providerOpenAIModelSelect.options).some(
        (o) => o.value === currentModel
      );
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = currentModel;
        opt.textContent = `${currentModel} (custom)`;
        providerOpenAIModelSelect.appendChild(opt);
      }
      providerOpenAIModelSelect.value = currentModel;
    }
  }
}

providerModeSelect?.addEventListener('change', () => {
  // Persist the in-progress edits of the mode we're leaving, then switch.
  if (currentProviderConfig.mode === 'openai') {
    currentProviderConfig.openai = {
      ...currentProviderConfig.openai,
      apiKey: providerOpenAIKeyInput?.value ?? '',
      model: providerOpenAIModelSelect?.value ?? 'gpt-4o-mini',
    };
  } else if (currentProviderConfig.mode === 'groq') {
    currentProviderConfig.groq = {
      ...currentProviderConfig.groq,
      apiKey: providerOpenAIKeyInput?.value ?? '',
      model: providerOpenAIModelSelect?.value ?? 'groq/compound',
    };
  } else {
    currentProviderConfig.managed = {
      ...currentProviderConfig.managed,
      model: providerOpenAIModelSelect?.value ?? 'gpt-4o-mini',
    };
  }
  currentProviderConfig.mode = providerModeSelect.value as ProviderMode;
  updateProviderUI();
  if (currentProviderConfig.mode === 'managed') void loadQuota();
});

function renderProviderForm(cfg: ProviderConfigDTO): void {
  currentProviderConfig = {
    mode: cfg.mode || 'managed',
    managed: cfg.managed || { model: 'gpt-4o-mini' },
    openai: cfg.openai || { apiKey: '', model: 'gpt-4o-mini' },
    groq: cfg.groq || { apiKey: '', model: 'groq/compound' },
  };
  if (providerModeSelect) providerModeSelect.value = currentProviderConfig.mode;
  updateProviderUI();
}

/** Fetch + render the managed free-tier balance. No-op for BYOK modes. */
async function loadQuota(): Promise<void> {
  if (!providerQuota) return;
  if (currentProviderConfig.mode !== 'managed') {
    providerQuota.style.display = 'none';
    return;
  }
  providerQuota.style.display = '';
  providerQuota.textContent = 'Free AI: checking balance…';
  const resp = await new Promise<{
    ok: boolean;
    unlimited?: boolean;
    usedUSD?: number;
    limitUSD?: number;
    remainingUSD?: number;
  }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'quota.get' }, (r) => resolve(r ?? { ok: false }));
  });
  if (!resp.ok || resp.unlimited) {
    providerQuota.textContent = 'Free AI: balance unavailable';
    return;
  }
  const used = resp.usedUSD ?? 0;
  const limit = resp.limitUSD ?? 0;
  const remaining = resp.remainingUSD ?? Math.max(0, limit - used);
  // Show a friendly "tokens" credit instead of raw dollars ($0.10 = 1 token,
  // so the $2 free tier reads as 20 tokens).
  const USD_PER_TOKEN = 0.1;
  const remainingTokens = Math.round(remaining / USD_PER_TOKEN);
  const limitTokens = Math.round(limit / USD_PER_TOKEN);
  providerQuota.textContent = `Free AI: ${remainingTokens} of ${limitTokens} tokens left`;
  const empty = remaining <= 0;
  providerQuota.classList.toggle('provider-quota--empty', empty);
  if (empty) showByokSwitchBanner();
  else hideByokSwitchBanner();
}

/** Show the quota-exhausted banner prompting a switch to the user's own key. */
function showByokSwitchBanner(): void {
  if (byokBanner) byokBanner.style.display = '';
}

function hideByokSwitchBanner(): void {
  if (byokBanner) byokBanner.style.display = 'none';
}

/** True for a managed-tier quota-exhausted failure (structured or by message). */
function isQuotaError(resp: { reason?: string; error?: string }): boolean {
  if (resp.reason === 'quota') return true;
  return /quota_exceeded|free ai allowance/i.test(resp.error ?? '');
}

// Banner CTA: flip provider mode to BYOK (OpenAI), reveal the key field, focus it.
byokBannerSwitch?.addEventListener('click', () => {
  hideByokSwitchBanner();
  if (providerModeSelect) {
    providerModeSelect.value = 'openai';
    currentProviderConfig.mode = 'openai';
    updateProviderUI();
  }
  byokBanner?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  providerOpenAIKeyInput?.focus();
});

async function loadProviderConfig(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; config?: ProviderConfigDTO }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'provider.get' }, (r) => resolve(r ?? { ok: false }));
  });
  const cfg = resp.config ?? { ...DEFAULT_PROVIDER_DTO };
  renderProviderForm(cfg);
  void loadQuota();
  try {
    const profile = await getUserProfile();
    updateOnboardingBanner(profile);
  } catch {
    updateOnboardingBanner(null);
  }
}

async function handleProviderSave(): Promise<void> {
  if (!providerSaveBtn) return;
  const mode = (providerModeSelect?.value as ProviderMode) ?? 'managed';
  const apiKey = providerOpenAIKeyInput?.value.trim() ?? '';
  const model =
    providerOpenAIModelSelect?.value ??
    (mode === 'groq' ? 'groq/compound' : 'gpt-4o-mini');

  if (mode === 'managed') {
    // Free tier — no key required.
    currentProviderConfig.managed = { ...currentProviderConfig.managed, model };
  } else {
    if (!apiKey) {
      showProviderMessage('API key is required.', 'error');
      return;
    }
    if (mode === 'openai') {
      currentProviderConfig.openai = { ...currentProviderConfig.openai, apiKey, model };
    } else {
      currentProviderConfig.groq = { ...currentProviderConfig.groq, apiKey, model };
    }
  }
  currentProviderConfig.mode = mode;

  providerSaveBtn.disabled = true;
  const prev = providerSaveBtn.innerHTML;
  providerSaveBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Saving…';
  try {
    const resp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'provider.set', config: currentProviderConfig }, (r) =>
        resolve(r ?? { ok: false, error: 'No response from background' })
      );
    });
    if (resp.ok) {
      const savedLabel = mode === 'managed' ? 'LinkMate free AI' : `${model}`;
      showProviderMessage(`Saved. Using ${savedLabel}. Click "Get AI rewrites" in Profile audit now.`, 'success');
      if (mode === 'managed') void loadQuota();
      // Make sure the audit section re-renders into the idle state and
      // (if visible) flashes a hint so the user knows where to retry.
      await loadProfileAudit();
      showAuditStatus('AI provider saved — click Get AI rewrites for suggestions.', 'info');
      try {
        const profile = await getUserProfile();
        updateOnboardingBanner(profile);
      } catch {
        updateOnboardingBanner(null);
      }
    } else {
      showProviderMessage(`Save failed: ${resp.error ?? 'unknown'}`, 'error');
    }
  } finally {
    providerSaveBtn.disabled = false;
    providerSaveBtn.innerHTML = prev;
  }
}

// ─── Capture Hero (top-of-panel status + stats; issue #16 UX) ───────────────

const heroSection = $('captureHero');
const heroIcon = $('captureHeroIcon');
const heroTitle = $('captureHeroTitle');
const heroSubtitle = $('captureHeroSubtitle');
const heroStats = $('captureHeroStats');
const heroStatExp = $('statExp');
const heroStatEdu = $('statEdu');
const heroStatSkl = $('statSkl');
const heroStatPst = $('statPst');
const heroStatCmt = $('statCmt');
const heroRefreshBtn = $<HTMLButtonElement>('heroRefresh');
const heroCopyBtn = $<HTMLButtonElement>('heroCopyJson');
const heroMessageEl = $('captureHeroMessage');

type HeroState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ok'; profile: UserProfile }
  | { kind: 'error'; message: string };

function setHeroClass(variant: 'empty' | 'loading' | 'ok' | 'error'): void {
  if (!heroSection) return;
  heroSection.classList.remove(
    'capture-hero--empty',
    'capture-hero--loading',
    'capture-hero--ok',
    'capture-hero--error'
  );
  heroSection.classList.add(`capture-hero--${variant}`);
}

function showHeroMessage(text: string): void {
  if (!heroMessageEl) return;
  heroMessageEl.textContent = text;
  heroMessageEl.style.display = '';
  setTimeout(() => {
    if (heroMessageEl) heroMessageEl.style.display = 'none';
  }, 4000);
}

function renderHero(state: HeroState): void {
  if (!heroSection) return;
  setHeroClass(state.kind);
  if (heroStats) heroStats.style.display = state.kind === 'ok' ? '' : 'none';
  if (heroCopyBtn) heroCopyBtn.style.display = state.kind === 'ok' ? '' : 'none';
  if (heroRefreshBtn) heroRefreshBtn.disabled = state.kind === 'loading';

  if (state.kind === 'empty') {
    if (heroIcon) heroIcon.textContent = '○';
    if (heroTitle) heroTitle.textContent = 'No profile captured yet';
    if (heroSubtitle) heroSubtitle.textContent = 'Click below to scan your LinkedIn profile.';
    if (heroRefreshBtn) heroRefreshBtn.innerHTML = '<i class="fa fa-camera"></i> Capture profile';
    return;
  }
  if (state.kind === 'loading') {
    if (heroIcon) heroIcon.textContent = '⏳';
    if (heroTitle) heroTitle.textContent = 'Capturing your profile…';
    if (heroSubtitle)
      heroSubtitle.textContent = 'This usually takes about 20 seconds — leave the side panel open.';
    if (heroRefreshBtn)
      heroRefreshBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Working…';
    return;
  }
  if (state.kind === 'error') {
    if (heroIcon) heroIcon.textContent = '✕';
    if (heroTitle) heroTitle.textContent = 'Capture failed';
    if (heroSubtitle) heroSubtitle.textContent = state.message;
    if (heroRefreshBtn) heroRefreshBtn.innerHTML = '<i class="fa fa-redo"></i> Try again';
    return;
  }
  // ok
  const p = state.profile;
  if (heroIcon) heroIcon.textContent = '✅';
  if (heroTitle) heroTitle.textContent = p.name || 'Profile captured';
  if (heroSubtitle)
    heroSubtitle.textContent = `Captured ${formatRelativeIso(p.capturedAt)} · ${
      p.location ?? 'no location'
    }`;
  if (heroStatExp) heroStatExp.textContent = String(p.experience.length);
  if (heroStatEdu) heroStatEdu.textContent = String(p.education.length);
  if (heroStatSkl) heroStatSkl.textContent = String(p.skills.length);
  if (heroStatPst) heroStatPst.textContent = String(p.recentPosts.length);
  if (heroStatCmt) heroStatCmt.textContent = String(p.recentComments.length);
  if (heroRefreshBtn) heroRefreshBtn.innerHTML = '<i class="fa fa-redo"></i> Refresh capture';
}

function formatRelativeIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'recently';
  return formatRelativeTime(t);
}

async function refreshCaptureHero(): Promise<void> {
  try {
    const profile = await getUserProfile();
    renderHero(profile ? { kind: 'ok', profile } : { kind: 'empty' });
    updateOnboardingBanner(profile);
  } catch {
    renderHero({ kind: 'empty' });
    updateOnboardingBanner(null);
  }
}

function updateOnboardingBanner(profile: UserProfile | null): void {
  const banner = document.getElementById('onboardingBanner');
  const text = document.getElementById('onboardingBannerText');
  const icon = document.getElementById('onboardingBannerIcon');
  if (!banner || !text || !icon) return;
  const cfg = currentProviderConfig;
  // Managed mode always has AI (no key needed) → only the profile gate applies.
  const hasAI =
    cfg.mode === 'managed' ||
    !!(cfg.mode === 'openai' ? cfg.openai?.apiKey?.trim() : cfg.groq?.apiKey?.trim());
  if (!hasAI) {
    banner.style.display = '';
    banner.classList.remove('onboarding-banner--profile');
    icon.className = 'fa fa-hand-point-down';
    text.textContent = '👋 Paste your OpenAI API key below to start.';
    return;
  }
  if (!profile) {
    banner.style.display = '';
    banner.classList.add('onboarding-banner--profile');
    icon.className = 'fa fa-camera';
    text.textContent = "👋 Click 'Capture profile' to scan your LinkedIn.";
    return;
  }
  banner.style.display = 'none';
}

async function handleHeroRefresh(): Promise<void> {
  renderHero({ kind: 'loading' });
  await handleCaptureProfile();
  await refreshCaptureHero();
  await loadProfileAudit();
}

async function handleHeroCopyJson(): Promise<void> {
  try {
    const profile = await getUserProfile();
    if (!profile) return;
    await navigator.clipboard.writeText(JSON.stringify(profile, null, 2));
    showHeroMessage('Copied JSON to clipboard.');
  } catch (err) {
    showHeroMessage(`Copy failed: ${String(err)}`);
  }
}

// ─── Profile audit (issue #28) ──────────────────────────────────────────────

interface ProfileAuditDTO {
  profileCapturedAt: string;
  audit: {
    checks: Array<{
      id: string;
      status: 'pass' | 'fail';
      severity: 'high' | 'med';
      label: string;
      detail: string;
    }>;
    passed: number;
    total: number;
    score: number;
    failed: string[];
  };
  recommendations: Array<{
    checkId: string;
    diagnosis: string;
    suggestion: string;
    rationale: string;
  }> | null;
  recommendationsAt: number;
  ssi: SsiSnapshot | null;
  avoidStems?: string[];
  activitySignals?: ActivitySignal[];
}

type AuditCategory = 'branding' | 'professional' | 'network';

interface AuditRow {
  id: string;
  category: AuditCategory;
  status: 'pass' | 'fail' | 'low';
  label: string;
  desc: string;
  guidance?: string;
}

const profileAuditSection = $('profileAudit');
const profileAuditList = $<HTMLUListElement>('profileAuditList');
const profileAuditStrengthWrap = profileAuditSection?.querySelector<HTMLDivElement>(
  '.profile-audit__strength',
);
const profileAuditScoreFg = document.getElementById('profileAuditScoreFg') as SVGCircleElement | null;
const profileAuditScoreText = $('profileAuditScoreText');
const profileAuditStrengthTitle = $('profileAuditStrengthTitle');
const profileAuditStrengthSub = $('profileAuditStrengthSub');
const profileAuditFilters = $<HTMLDivElement>('profileAuditFilters');
const profileAuditRewriteBtn = $<HTMLButtonElement>('profileAuditRewrite');
const profileAuditRewriteLabel = $('profileAuditRewriteLabel');
const profileAuditRerunBtn = $<HTMLButtonElement>('profileAuditRerun');
const profileAuditStatus = $('profileAuditStatus');

let currentAuditFilter: 'all' | AuditCategory = 'all';

const AUDIT_CATEGORIES: Record<string, AuditCategory> = {
  // 6 essentials
  currentPosition: 'professional',
  education: 'professional',
  skills: 'network',
  about: 'branding',
  location: 'branding',
  connections: 'network',
  // activity signals
  ssi: 'network',
  posts30d: 'branding',
  comments30d: 'branding',
  network500: 'network',
};

const CHECK_DESC: Record<string, { pass: (detail: string) => string; fail: (detail: string) => string }> = {
  currentPosition: {
    pass: (d) => `Your current role is listed: ${d}.`,
    fail: () => 'Add your current job title and company.',
  },
  education: {
    pass: (d) => `Your educational background is up to date: ${d}.`,
    fail: () => 'Add at least one school to your profile.',
  },
  skills: {
    pass: (d) => `You have ${d.replace(/[^0-9]/g, '')} skills listed on your profile.`,
    fail: () => 'Add at least 5 skills to your profile.',
  },
  about: {
    pass: () => 'Your About section is filled in and detailed.',
    fail: () => 'Write a richer About section (at least 50 characters).',
  },
  location: {
    pass: (d) => `Your location is set to ${d}.`,
    fail: () => 'Set your location so recruiters can find you.',
  },
  connections: {
    pass: (d) => `You have ${d} connections.`,
    fail: () => 'Grow your network to at least 50 connections.',
  },
};

function showAuditStatus(text: string, kind: 'success' | 'error' | 'info'): void {
  if (!profileAuditStatus) return;
  profileAuditStatus.textContent = text;
  profileAuditStatus.className = `status-message ${kind}`;
  profileAuditStatus.style.display = '';
  setTimeout(() => {
    if (profileAuditStatus) profileAuditStatus.style.display = 'none';
  }, 4000);
}

function buildAuditRows(state: ProfileAuditDTO): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const c of state.audit.checks) {
    const cat = AUDIT_CATEGORIES[c.id] ?? 'professional';
    const descFn = CHECK_DESC[c.id];
    const desc = descFn ? (c.status === 'pass' ? descFn.pass(c.detail) : descFn.fail(c.detail)) : c.detail;
    rows.push({ id: c.id, category: cat, status: c.status, label: c.label, desc });
  }
  for (const sig of state.activitySignals ?? []) {
    rows.push({
      id: sig.id,
      category: AUDIT_CATEGORIES[sig.id] ?? 'network',
      status: sig.status === 'ok' ? 'pass' : 'low',
      label: sig.label,
      desc: `${sig.detail}`,
      guidance: sig.status === 'low' ? sig.guidance : undefined,
    });
  }
  return rows;
}

function renderAuditList(state: ProfileAuditDTO): void {
  if (!profileAuditList) return;
  profileAuditList.innerHTML = '';
  const rows = buildAuditRows(state);

  type Rec = NonNullable<ProfileAuditDTO['recommendations']>[number];
  const recsByCheckId = new Map<string, Rec>();
  if (state.recommendations) {
    for (const r of state.recommendations) recsByCheckId.set(r.checkId, r);
  }

  // Two collapsible groups: "Need improvement" (yellow fail/low + advisory, open
  // by default) and "Looking good" (green/pass confirmations, collapsed).
  const improveList = document.createElement('ul');
  improveList.className = 'profile-audit__list profile-audit__group-list';
  let improveVisible = 0;
  const goodList = document.createElement('ul');
  goodList.className = 'profile-audit__list profile-audit__group-list';
  let goodVisible = 0;

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'profile-audit__check';
    li.dataset.category = row.category;
    if (currentAuditFilter !== 'all' && currentAuditFilter !== row.category) {
      li.hidden = true;
    }

    const mainRow = document.createElement('div');
    mainRow.className = 'profile-audit__check-row';

    const main = document.createElement('div');
    main.className = 'profile-audit__check-main';
    const icon = document.createElement('span');
    const iconKind = row.status === 'pass' ? 'pass' : row.status === 'low' ? 'low' : 'fail';
    icon.className = `profile-audit__check-icon profile-audit__check-icon--${iconKind}`;
    icon.innerHTML = `<i class="fa-solid ${row.status === 'pass' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i>`;
    icon.setAttribute('aria-label', row.status === 'pass' ? 'good' : 'needs attention');
    main.appendChild(icon);
    const text = document.createElement('div');
    text.className = 'profile-audit__check-text';
    const label = document.createElement('span');
    label.className = 'profile-audit__check-label';
    label.textContent = row.label;
    const desc = document.createElement('div');
    desc.className = 'profile-audit__check-desc';
    desc.textContent = row.desc;
    text.appendChild(label);
    text.appendChild(desc);
    main.appendChild(text);
    mainRow.appendChild(main);

    const tags = document.createElement('div');
    tags.className = 'profile-audit__check-tags';
    const catTag = document.createElement('span');
    catTag.className = `profile-audit__tag profile-audit__tag--${row.category}`;
    catTag.textContent = row.category.toUpperCase();
    const statusTag = document.createElement('span');
    const statusKind = row.status === 'pass' ? 'good' : row.status === 'low' ? 'low' : 'needswork';
    statusTag.className = `profile-audit__tag profile-audit__tag--${statusKind}`;
    statusTag.textContent =
      row.status === 'pass' ? 'GOOD' : row.status === 'low' ? 'LOW' : 'NEEDS WORK';
    tags.appendChild(catTag);
    tags.appendChild(statusTag);
    mainRow.appendChild(tags);

    li.appendChild(mainRow);

    if (row.guidance) {
      const g = document.createElement('div');
      g.className = 'profile-audit__guidance';
      g.textContent = row.guidance;
      li.appendChild(g);
    }

    const rec = recsByCheckId.get(row.id);
    if ((row.status === 'fail' || row.status === 'low') && rec) {
      li.appendChild(renderSuggestion(rec));
    }
    // Green "pass" → "Looking good"; everything that needs work → "Need improvement".
    if (row.status === 'pass') {
      goodList.appendChild(li);
      if (!li.hidden) goodVisible += 1;
    } else {
      improveList.appendChild(li);
      if (!li.hidden) improveVisible += 1;
    }
  }

  // Advisory recommendations (photoBanner, openToWork) rendered as extra rows
  // — categorised as Branding.
  if (state.recommendations) {
    for (const r of state.recommendations) {
      if (r.checkId !== 'photoBanner' && r.checkId !== 'openToWork') continue;
      const cat: AuditCategory = 'branding';
      const li = document.createElement('li');
      li.className = 'profile-audit__check';
      li.dataset.category = cat;
      if (currentAuditFilter !== 'all' && currentAuditFilter !== cat) li.hidden = true;
      const mainRow = document.createElement('div');
      mainRow.className = 'profile-audit__check-row';
      const main = document.createElement('div');
      main.className = 'profile-audit__check-main';
      const icon = document.createElement('span');
      icon.className = 'profile-audit__check-icon profile-audit__check-icon--low';
      icon.innerHTML = '<i class="fa-solid fa-circle-info"></i>';
      icon.setAttribute('aria-label', 'advisory');
      main.appendChild(icon);
      const text = document.createElement('div');
      text.className = 'profile-audit__check-text';
      const label = document.createElement('span');
      label.className = 'profile-audit__check-label';
      label.textContent = r.checkId === 'photoBanner' ? 'Photo & banner' : 'Open to Work';
      const desc = document.createElement('div');
      desc.className = 'profile-audit__check-desc';
      desc.textContent = r.diagnosis || 'Worth a closer look';
      text.appendChild(label);
      text.appendChild(desc);
      main.appendChild(text);
      mainRow.appendChild(main);
      const tags = document.createElement('div');
      tags.className = 'profile-audit__check-tags';
      const catTag = document.createElement('span');
      catTag.className = `profile-audit__tag profile-audit__tag--${cat}`;
      catTag.textContent = cat.toUpperCase();
      const statusTag = document.createElement('span');
      statusTag.className = 'profile-audit__tag profile-audit__tag--low';
      statusTag.textContent = 'TIP';
      tags.appendChild(catTag);
      tags.appendChild(statusTag);
      mainRow.appendChild(tags);
      li.appendChild(mainRow);
      li.appendChild(renderSuggestion(r));
      improveList.appendChild(li);
      if (!li.hidden) improveVisible += 1;
    }
  }

  // "Need improvement" — open by default (this is what to act on).
  appendAuditGroup(profileAuditList, {
    list: improveList,
    visible: improveVisible,
    label: 'Need improvement',
    icon: 'fa-circle-exclamation',
    tone: 'warn',
    open: true,
  });
  // "Looking good" — collapsed (just confirmation).
  appendAuditGroup(profileAuditList, {
    list: goodList,
    visible: goodVisible,
    label: 'Looking good',
    icon: 'fa-circle-check',
    tone: 'good',
    open: false,
  });
}

/** Wrap a list of audit rows in a collapsible group (<details>) with a header. */
function appendAuditGroup(
  parent: HTMLElement,
  opts: {
    list: HTMLUListElement;
    visible: number;
    label: string;
    icon: string;
    tone: 'warn' | 'good';
    open: boolean;
  },
): void {
  if (opts.list.children.length === 0) return;
  const wrapper = document.createElement('li');
  wrapper.className = 'profile-audit__group-wrapper';
  if (opts.visible === 0) wrapper.hidden = true;
  const details = document.createElement('details');
  details.className = `profile-audit__group profile-audit__group--${opts.tone}`;
  if (opts.open) details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'profile-audit__group-summary';
  summary.innerHTML = `<i class="fa-solid ${opts.icon}"></i> ${opts.label} <span class="profile-audit__group-count">${opts.visible}</span>`;
  details.appendChild(summary);
  details.appendChild(opts.list);
  wrapper.appendChild(details);
  parent.appendChild(wrapper);
}

function updateFilterCounts(state: ProfileAuditDTO): void {
  if (!profileAuditFilters) return;
  const rows = buildAuditRows(state);
  // Add advisory items to counts when present.
  const advisoryCount = (state.recommendations ?? []).filter(
    (r) => r.checkId === 'photoBanner' || r.checkId === 'openToWork',
  ).length;
  const counts = { all: 0, branding: 0, professional: 0, network: 0 } as Record<string, number>;
  for (const r of rows) {
    counts.all += 1;
    counts[r.category] += 1;
  }
  counts.all += advisoryCount;
  counts.branding += advisoryCount;
  profileAuditFilters.querySelectorAll<HTMLSpanElement>('[data-count-for]').forEach((el) => {
    const key = el.dataset.countFor ?? 'all';
    el.textContent = String(counts[key] ?? 0);
  });
}

function setAuditFilter(filter: 'all' | AuditCategory): void {
  currentAuditFilter = filter;
  profileAuditFilters?.querySelectorAll<HTMLButtonElement>('.profile-audit__filter').forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  profileAuditList?.querySelectorAll<HTMLLIElement>('.profile-audit__check').forEach((li) => {
    li.hidden = filter !== 'all' && li.dataset.category !== filter;
  });
}

function renderSuggestion(rec: {
  diagnosis: string;
  suggestion: string;
  rationale: string;
}): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'profile-audit__suggestion';

  const summary = document.createElement('summary');
  summary.className = 'profile-audit__suggestion-summary';
  summary.innerHTML =
    '<i class="fa fa-wand-magic-sparkles"></i><span>View AI suggestion</span><i class="fa fa-chevron-down profile-audit__chevron profile-audit__chevron--sm" aria-hidden="true"></i>';
  details.appendChild(summary);

  if (rec.diagnosis) {
    const d = document.createElement('div');
    d.className = 'profile-audit__suggestion-diagnosis';
    d.textContent = rec.diagnosis;
    details.appendChild(d);
  }

  const text = document.createElement('div');
  text.className = 'profile-audit__suggestion-text';
  text.textContent = rec.suggestion;
  details.appendChild(text);

  if (rec.rationale) {
    const r = document.createElement('div');
    r.className = 'profile-audit__suggestion-rationale';
    r.textContent = rec.rationale;
    details.appendChild(r);
  }

  const actions = document.createElement('div');
  actions.className = 'profile-audit__suggestion-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn-sm btn-secondary profile-audit__copy-btn';
  copyBtn.innerHTML = '<i class="fa fa-copy"></i> Copy';
  copyBtn.setAttribute('aria-label', 'Copy suggested text');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void navigator.clipboard
      .writeText(rec.suggestion)
      .then(() => showAuditStatus('Copied to clipboard.', 'success'))
      .catch((err) => showAuditStatus(`Copy failed: ${String(err)}`, 'error'));
  });
  actions.appendChild(copyBtn);
  details.appendChild(actions);

  return details;
}

/** Compute a single profile-strength % combining the 6 essentials with
 *  activity signals — what the score circle displays. Essentials count
 *  double-weight because they are mandatory profile completeness. */
function computeStrengthScore(state: ProfileAuditDTO): { pct: number; passed: number; total: number } {
  const passEssentials = state.audit.passed;
  const totalEssentials = state.audit.total;
  const sigs = state.activitySignals ?? [];
  const passSigs = sigs.filter((s) => s.status === 'ok').length;
  const totalSigs = sigs.length;
  // 2× weight to essentials.
  const num = passEssentials * 2 + passSigs;
  const denom = totalEssentials * 2 + totalSigs || 1;
  const pct = Math.round((num / denom) * 100);
  return { pct, passed: passEssentials + passSigs, total: totalEssentials + totalSigs };
}

function strengthBand(pct: number): { mod: '' | 'mid' | 'low'; title: string; sub: (p: number) => string } {
  if (pct >= 80) return {
    mod: '',
    title: 'All-Star Profile Strength!',
    sub: (p) => `Your profile is ${p}% optimized. Keep the momentum — small polish opportunities below.`,
  };
  if (pct >= 50) return {
    mod: 'mid',
    title: 'Strong Profile · room to sharpen',
    sub: (p) => `Your profile is ${p}% optimized. Fix the items flagged below to break into the top tier.`,
  };
  return {
    mod: 'low',
    title: 'Profile Needs Work',
    sub: (p) => `Your profile is ${p}% optimized. Start with the high-severity items below to climb fast.`,
  };
}

function renderProfileAudit(state: ProfileAuditDTO | null): void {
  if (!profileAuditSection) return;
  if (!state) {
    profileAuditSection.style.display = 'none';
    return;
  }
  profileAuditSection.style.display = '';

  const { pct } = computeStrengthScore(state);
  const band = strengthBand(pct);
  if (profileAuditStrengthWrap) {
    profileAuditStrengthWrap.classList.remove(
      'profile-audit__strength--mid',
      'profile-audit__strength--low',
    );
    if (band.mod) profileAuditStrengthWrap.classList.add(`profile-audit__strength--${band.mod}`);
  }
  if (profileAuditScoreFg) {
    const circumference = 2 * Math.PI * 42;
    profileAuditScoreFg.style.strokeDasharray = String(circumference);
    profileAuditScoreFg.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  }
  if (profileAuditScoreText) profileAuditScoreText.textContent = String(pct);
  if (profileAuditStrengthTitle) profileAuditStrengthTitle.textContent = band.title;
  if (profileAuditStrengthSub) {
    const ssiSuffix = state.ssi ? ` SSI ${state.ssi.total}/100.` : '';
    profileAuditStrengthSub.textContent = band.sub(pct) + ssiSuffix;
  }

  updateFilterCounts(state);
  renderAuditList(state);

  if (profileAuditRewriteBtn && profileAuditRewriteLabel) {
    const failedCount = state.audit.failed.length;
    if (state.recommendations) {
      profileAuditRewriteLabel.textContent = 'Regenerate AI rewrites';
    } else if (failedCount === 0) {
      profileAuditRewriteLabel.textContent = 'Get advice anyway';
    } else {
      profileAuditRewriteLabel.textContent = `Get AI rewrites for ${failedCount} gap${failedCount === 1 ? '' : 's'}`;
    }
    profileAuditRewriteBtn.dataset.state = 'idle';
    profileAuditRewriteBtn.disabled = false;
  }
}

async function loadProfileAudit(): Promise<void> {
  try {
    const resp = await new Promise<{ ok: boolean; state?: ProfileAuditDTO | null }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'profile.audit.get' }, (r) => resolve(r ?? { ok: false }));
    });
    if (!resp.ok) {
      renderProfileAudit(null);
      return;
    }
    renderProfileAudit(resp.state ?? null);
  } catch {
    renderProfileAudit(null);
  }
}

async function handleProfileAuditRewrite(): Promise<void> {
  if (!profileAuditRewriteBtn || !profileAuditRewriteLabel) return;
  if (profileAuditRewriteBtn.disabled) return;
  // If the label currently reads "Regenerate…", tell background to carry
  // forward the previously stored avoid-stems so the LLM produces a
  // genuinely different framing.
  const isRegenerate = (profileAuditRewriteLabel.textContent ?? '').toLowerCase().includes('regenerate');
  profileAuditRewriteBtn.disabled = true;
  profileAuditRewriteBtn.dataset.state = 'loading';
  const prevLabel = profileAuditRewriteLabel.textContent;
  profileAuditRewriteLabel.textContent = isRegenerate ? 'Regenerating…' : 'Generating rewrites…';
  try {
    const resp = await new Promise<{
      ok: boolean;
      state?: ProfileAuditDTO;
      reason?: string;
      error?: string;
    }>((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'profile.audit.rewrite', regenerate: isRegenerate },
        (r) => resolve(r ?? { ok: false, reason: 'network' }),
      );
    });
    if (!resp.ok) {
      profileAuditRewriteBtn.disabled = false;
      profileAuditRewriteBtn.dataset.state = 'idle';
      profileAuditRewriteLabel.textContent = prevLabel ?? 'Get AI rewrites';
      if (isQuotaError(resp)) {
        showAuditStatus('Free AI used up — switch to your own key to continue.', 'info');
        showByokSwitchBanner();
      } else if (resp.reason === 'no_key') {
        showAuditStatus(
          'Add an OpenAI key in Settings to get AI rewrites.',
          'info',
        );
      } else if (resp.reason === 'no_profile') {
        showAuditStatus('Capture your profile first.', 'error');
      } else if (resp.reason === 'parse') {
        showAuditStatus('AI returned malformed JSON. Try again.', 'error');
      } else {
        showAuditStatus(`Failed: ${resp.error ?? 'unknown error'}`, 'error');
      }
      return;
    }
    if (resp.state) renderProfileAudit(resp.state);
  } catch (err) {
    profileAuditRewriteBtn.disabled = false;
    profileAuditRewriteBtn.dataset.state = 'idle';
    profileAuditRewriteLabel.textContent = prevLabel ?? 'Get AI rewrites';
    showAuditStatus(`Failed: ${String(err)}`, 'error');
  }
}

async function handleProfileAuditRerun(): Promise<void> {
  await loadProfileAudit();
  showAuditStatus('Audit refreshed.', 'success');
}

// ─── Profile Context ────────────────────────────────────────────────────────

const captureProfileBtn = $<HTMLButtonElement>('captureProfile');
const profileNoneState = $('profileNoneState');
const profileCapturedState = $('profileCapturedState');
const profileFullName = $('profileFullName');
const profileHeadline = $('profileHeadline');
const profilePositioning = $('profilePositioning');
const profileCapturedAt = $('profileCapturedAt');
const profileSkillsCount = $('profileSkillsCount');
const profileStaleChip = $('profileStaleChip');
const profileMessage = $('profileMessage');
const captureFullProfileToggle = $<HTMLInputElement>('captureFullProfile');
const deepScrapeProgressEl = $<HTMLDivElement>('deepScrapeProgress');
const deepScrapeProgressText = $<HTMLSpanElement>('deepScrapeProgressText');
const deepScrapeCancelBtn = $<HTMLButtonElement>('deepScrapeCancelBtn');
const profileService = new ProfileContextService();

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderProfile(profile: ProfileContext | null, isStale: boolean): void {
  if (!profile) {
    if (profileNoneState) profileNoneState.style.display = '';
    if (profileCapturedState) profileCapturedState.style.display = 'none';
    return;
  }
  if (profileNoneState) profileNoneState.style.display = 'none';
  if (profileCapturedState) profileCapturedState.style.display = '';
  if (profileFullName) profileFullName.textContent = profile.fullName || '(no name)';
  if (profileHeadline) profileHeadline.textContent = profile.headline || '(no headline)';
  if (profilePositioning)
    profilePositioning.textContent = profile.positioningSummary || '(no positioning summary)';
  if (profileCapturedAt) profileCapturedAt.textContent = formatRelativeTime(profile.capturedAt);
  if (profileSkillsCount) profileSkillsCount.textContent = String(profile.topSkills.length);
  if (profileStaleChip) profileStaleChip.style.display = isStale ? '' : 'none';
}

function showProfileMessage(text: string, kind: 'success' | 'error' | 'info'): void {
  if (!profileMessage) return;
  profileMessage.textContent = text;
  profileMessage.className = `status-message ${kind}`;
  profileMessage.style.display = '';
  setTimeout(() => {
    if (profileMessage) profileMessage.style.display = 'none';
  }, 6000);
}

async function refreshProfileDisplay(): Promise<void> {
  const profile = await profileService.get();
  const stale = await profileService.shouldRefresh();
  renderProfile(profile, profile !== null && stale);
  // Hero card uses IDB data (richer than chrome.storage ProfileContext) — keep them in sync.
  await refreshCaptureHero();
}

// NOTE: `getLinkedInTabId` + `ensureOnOwnProfile` were removed when profile
// capture moved to a hidden background tab — see ProfileContextService.capture
// in src/profile-context.ts. The hidden-tab flow never disturbs the user's
// current LinkedIn tab, so the popup no longer needs to resolve a target tab.
// The `?targetTab=` URL param is still honoured inside profile-context.ts via
// its own getExplicitTargetTabId helper.

const PENDING_CAPTURE_KEY = 'linkmate.pendingCapture.v1';

/**
 * One-shot auto-capture: fires only when the Welcome page set a pending flag
 * (i.e. user just clicked Get Started). Subsequent panel opens are no-ops —
 * refresh is fully user-driven via the Hero card's Refresh button.
 */
async function maybeAutoCapture(): Promise<void> {
  const { [PENDING_CAPTURE_KEY]: pending } = await chrome.storage.local.get(PENDING_CAPTURE_KEY);
  if (!pending) return;
  // Consume the flag immediately so we don't loop on panel reload.
  await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
  await handleCaptureProfile();
}

// Module-level guard so concurrent triggers (welcome auto-fire, Hero refresh
// click, legacy Profile Context button) don't race each other on the same
// tab — each capture nav-jumps the user's LinkedIn tab, parallel runs would
// trash each other's state.
let captureInFlight = false;

async function handleCaptureProfile(): Promise<void> {
  if (captureInFlight) {
    console.warn('[LinkMate] capture already in flight; ignoring duplicate trigger');
    return;
  }
  captureInFlight = true;
  // Instant feedback: show the progress bar the moment capture starts, before
  // the background tab + scraper write their first real progress event (that
  // setup takes a couple of seconds and otherwise looks like nothing happened).
  if (captureFullProfileToggle?.checked) {
    renderDeepScrapeProgress({ phase: 'profile', iter: 0, items: 0, height: 0, ts: 0 });
  }
  if (!captureProfileBtn) {
    // Allow flow to continue even without the legacy button mounted.
  }
  const prevText = captureProfileBtn?.innerHTML;
  if (captureProfileBtn) {
    captureProfileBtn.disabled = true;
    captureProfileBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Capturing…';
  }
  const setBtnLabel = (label: string) => {
    if (captureProfileBtn) {
      captureProfileBtn.innerHTML = `<i class="fa fa-circle-notch fa-spin"></i> ${label}`;
    }
  };
  const STEP_LABELS: Record<string, string> = {
    'cache-check': 'Checking cache…',
    'opening-tab': 'Opening your profile…',
    'waiting-profile-load': 'Loading profile…',
    scraping: 'Scraping profile…',
    parsing: 'Parsing fields…',
    summarizing: 'Summarizing…',
    done: 'Done',
  };
  try {
    const result = await profileService.capture({
      onProgress: (step) => {
        const label = STEP_LABELS[step];
        if (label) setBtnLabel(label);
      },
    });
    if (result.ok) {
      if (result.cached) {
        showProfileMessage('Profile is fresh (<24h). Using cached snapshot.', 'info');
      } else if (result.summaryError) {
        showProfileMessage(
          '✅ Profile captured. (AI summary skipped — check OpenAI key in Settings.)',
          'info'
        );
      } else {
        showProfileMessage('✅ Profile captured successfully.', 'success');
      }
      // Issue #16 follow-up: also kick off an SSI snapshot so both visuals
      // light up together. Fire-and-forget; SSI refresh updates its own panel
      // section via loadSsiData when it completes.
      if (!result.cached) {
        void (async () => {
          try {
            await new Promise<void>((resolve) => {
              chrome.runtime.sendMessage({ action: 'ssi.captureNow' }, () => resolve());
            });
            await loadSsiData();
          } catch {
            /* SSI capture is best-effort; ignore failures */
          }
        })();
      }
      // System notification so the user knows even if focus moved elsewhere.
      try {
        const exp = result.userProfile?.experience.length ?? 0;
        const edu = result.userProfile?.education.length ?? 0;
        const sk = result.userProfile?.skills.length ?? 0;
        // Unique id per capture so back-to-back successes don't silently
        // replace each other (Chrome treats same id as an update).
        chrome.notifications?.create?.(`linkmate-capture-${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
          title: 'LinkMate — profile captured',
          message: `${exp} experiences · ${edu} education · ${sk} skills saved.`,
          priority: 1,
        });
      } catch {
        /* notifications permission may be denied; ignore */
      }
      await refreshProfileDisplay();
    } else {
      showProfileMessage(result.message, 'error');
    }
  } catch (err) {
    showProfileMessage(`Unexpected error: ${String(err)}`, 'error');
  } finally {
    captureInFlight = false;
    // Capture (incl. the deep scrape) is fully awaited above, so by here the
    // scraper has cleared its own progress; this just covers the cached / quick
    // path where no scrape events fired and the instant bar would otherwise hang.
    renderDeepScrapeProgress(null);
    if (captureProfileBtn) {
      captureProfileBtn.disabled = false;
      if (prevText !== undefined) captureProfileBtn.innerHTML = prevText;
    }
  }
}

async function loadCaptureFullProfileToggle(): Promise<void> {
  if (!captureFullProfileToggle) return;
  captureFullProfileToggle.checked = await getCaptureFullProfile();
}

async function handleCaptureFullProfileToggle(): Promise<void> {
  if (!captureFullProfileToggle) return;
  await setCaptureFullProfile(captureFullProfileToggle.checked);
}

const SCRAPE_PHASE_ORDER: Array<DeepScrapeProgress['phase']> = ['profile', 'posts', 'comments'];

function renderDeepScrapeProgress(p: DeepScrapeProgress | null): void {
  if (!deepScrapeProgressEl) return;
  if (!p) {
    deepScrapeProgressEl.style.display = 'none';
    return;
  }
  deepScrapeProgressEl.style.display = 'block';

  // Friendly, non-technical status (no raw iteration counter).
  if (deepScrapeProgressText) {
    const headline =
      p.phase === 'posts'
        ? 'Collecting your recent posts…'
        : p.phase === 'comments'
          ? 'Collecting your recent comments…'
          : 'Reading your profile…';
    const count = p.items > 0 ? ` · ${p.items} collected` : '';
    deepScrapeProgressText.textContent = `${headline}${count}`;
  }

  // Mark the step pills: past phases done, current active.
  const current = SCRAPE_PHASE_ORDER.indexOf(p.phase);
  deepScrapeProgressEl
    .querySelectorAll<HTMLElement>('.deep-scrape-progress__steps span')
    .forEach((el) => {
      const idx = SCRAPE_PHASE_ORDER.indexOf(el.dataset.phase as DeepScrapeProgress['phase']);
      el.classList.toggle('is-done', idx < current);
      el.classList.toggle('is-active', idx === current);
    });
}

async function handleDeepScrapeCancel(): Promise<void> {
  await setDeepScrapeCancel(true);
  if (deepScrapeProgressText) deepScrapeProgressText.textContent = 'Cancelling…';
}

function wireDeepScrapeProgressListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(STORAGE_KEYS.deepScrapeProgress in changes)) return;
    const change = changes[STORAGE_KEYS.deepScrapeProgress];
    const next = change.newValue as DeepScrapeProgress | undefined;
    renderDeepScrapeProgress(next ?? null);
    // Scrape just finished (progress cleared after running) → the captured
    // profile + audit are ready, so refresh them without needing a reopen.
    if (!next && change.oldValue) {
      setTimeout(() => {
        void refreshCaptureHero();
        void loadProfileAudit();
      }, 600);
    }
  });
}

// ─── SSI Tracker ────────────────────────────────────────────────────────────

const ssiNoneState = $('ssiNoneState');
const ssiCapturedState = $('ssiCapturedState');
const ssiTotal = $('ssiTotal');
const ssiIndustry = $('ssiIndustry');
const ssiNetwork = $('ssiNetwork');
const ssiCapturedAt = $('ssiCapturedAt');
const ssiCompBrand = $('ssiCompBrand');
const ssiCompFind = $('ssiCompFind');
const ssiCompEngage = $('ssiCompEngage');
const ssiCompBuild = $('ssiCompBuild');
const ssiInsight = $('ssiInsight');
const ssiErrorChip = $('ssiErrorChip');
const ssiTrendCanvas = $<HTMLCanvasElement>('ssiTrendCanvas');
const ssiDonutCanvas = $<HTMLCanvasElement>('ssiDonutCanvas');
const ssiDonutTotal = $('ssiDonutTotal');
const ssiRefreshBtn = $<HTMLButtonElement>('ssiRefresh');
const ssiOpenPageBtn = $<HTMLButtonElement>('ssiOpenPage');
const ssiMessage = $('ssiMessage');

let ssiChart: { destroy: () => void } | null = null;
let ssiDonutChart: { destroy: () => void } | null = null;

// Chart.js is imported statically (not via `await import()`). A dynamic import
// makes Parcel split a chunk and emit an inline `<script type="importmap">`,
// which the MV3 CSP `script-src 'self'` blocks — so the charts silently failed
// to load. MV3 forbids inline-script hashes/nonces on extension pages, so a
// static import (no async chunk, no importmap) is the reliable fix. The SSI
// dashboard renders charts on open anyway, so lazy-loading bought little.
async function loadChartCtor(): Promise<unknown> {
  return ChartCtor;
}

function ssiRefs() {
  return {
    total: ssiTotal,
    industry: ssiIndustry,
    network: ssiNetwork,
    capturedAt: ssiCapturedAt,
    components: {
      establishBrand: ssiCompBrand,
      findRightPeople: ssiCompFind,
      engageWithInsights: ssiCompEngage,
      buildRelationships: ssiCompBuild,
    },
  };
}

function showSsiMessage(text: string, kind: 'success' | 'error' | 'info'): void {
  if (!ssiMessage) return;
  ssiMessage.textContent = text;
  ssiMessage.className = `status-message ${kind}`;
  ssiMessage.style.display = '';
  setTimeout(() => {
    if (ssiMessage) ssiMessage.style.display = 'none';
  }, 6000);
}

async function loadSsiData(): Promise<void> {
  const [historyResp, lastError] = await Promise.all([
    new Promise<{ snapshots: SsiSnapshot[] }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'ssi.getHistory' }, (resp) => {
        resolve(resp ?? { snapshots: [] });
      });
    }),
    getSsiLastError(),
  ]);

  const snapshots = historyResp.snapshots ?? [];
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  if (!latest) {
    if (ssiNoneState) ssiNoneState.style.display = '';
    if (ssiCapturedState) ssiCapturedState.style.display = 'none';
  } else {
    if (ssiNoneState) ssiNoneState.style.display = 'none';
    if (ssiCapturedState) ssiCapturedState.style.display = '';
    renderSsiLatest(latest, ssiRefs());
    if (ssiInsight) ssiInsight.textContent = getSsiInsight(snapshots);
    if (ssiTrendCanvas) {
      if (ssiChart) {
        try {
          ssiChart.destroy();
        } catch {
          /* ignore */
        }
      }
      const ChartCtor = await loadChartCtor();
      ssiChart = renderSsiTrend(snapshots, ssiTrendCanvas, ChartCtor as never);
    }
    if (ssiDonutCanvas) {
      if (ssiDonutChart) {
        try {
          ssiDonutChart.destroy();
        } catch {
          /* ignore */
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Chart.js dynamic load
      const ChartCtor = (await loadChartCtor()) as any;
      const c = latest.components;
      ssiDonutChart = new ChartCtor(ssiDonutCanvas, {
        type: 'doughnut',
        data: {
          labels: ['Establish brand', 'Find people', 'Engage', 'Build relationships'],
          datasets: [
            {
              data: [
                c.establishBrand,
                c.findRightPeople,
                c.engageWithInsights,
                c.buildRelationships,
              ],
              backgroundColor: ['#e87726', '#9d75d6', '#15a895', '#1a91c4'],
              borderColor: '#ffffff',
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Chart.js context
                label: (ctx: any) => `${ctx.label}: ${ctx.parsed.toFixed(2)} / 25`,
              },
            },
          },
        },
      });
      if (ssiDonutTotal) ssiDonutTotal.textContent = String(latest.total);
    }
  }

  if (ssiErrorChip) {
    if (lastError) {
      ssiErrorChip.textContent = `Last capture failed: ${lastError.message}`;
      ssiErrorChip.style.display = '';
    } else {
      ssiErrorChip.style.display = 'none';
    }
  }
}

async function handleSsiRefresh(): Promise<void> {
  if (!ssiRefreshBtn) return;
  ssiRefreshBtn.disabled = true;
  const prevHtml = ssiRefreshBtn.innerHTML;
  ssiRefreshBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Capturing…';
  try {
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'ssi.captureNow' }, (resp) => {
        resolve(resp ?? { ok: false, error: 'No response from background' });
      });
    });
    if (result.ok) {
      showSsiMessage('SSI snapshot captured.', 'success');
      await loadSsiData();
    } else {
      showSsiMessage(`Capture failed: ${result.error ?? 'unknown'}`, 'error');
      await loadSsiData();
    }
  } finally {
    ssiRefreshBtn.disabled = false;
    ssiRefreshBtn.innerHTML = prevHtml;
  }
}

function handleSsiOpenPage(): void {
  chrome.tabs.create({ url: 'https://www.linkedin.com/sales/ssi' });
}

// ─── AI Parameters ──────────────────────────────────────────────────────────

const temperatureSlider = $<HTMLInputElement>('temperatureSlider');
const temperatureValue = $('temperatureValue');
const maxTokensSlider = $<HTMLInputElement>('maxTokensSlider');
const maxTokensValue = $('maxTokensValue');
const saveParametersBtn = $<HTMLButtonElement>('saveParameters');
const resetParametersBtn = $<HTMLButtonElement>('resetParameters');
const parameterStatus = $('parameterStatus');

const DEFAULT_TEMPERATURE = 0.85;
const DEFAULT_MAX_TOKENS = 150;

function showParameterStatus(text: string, kind: 'success' | 'error'): void {
  if (!parameterStatus) return;
  parameterStatus.textContent = text;
  parameterStatus.className = `status-message ${kind}`;
  parameterStatus.style.display = '';
  setTimeout(() => {
    if (parameterStatus) parameterStatus.style.display = 'none';
  }, 4000);
}

async function loadAIParameters(): Promise<void> {
  const result = await chrome.storage.sync.get(['aiTemperature', 'aiMaxTokens']);
  const t = typeof result.aiTemperature === 'number' ? result.aiTemperature : DEFAULT_TEMPERATURE;
  const m = typeof result.aiMaxTokens === 'number' ? result.aiMaxTokens : DEFAULT_MAX_TOKENS;
  if (temperatureSlider) temperatureSlider.value = String(t);
  if (temperatureValue) temperatureValue.textContent = String(t);
  if (maxTokensSlider) maxTokensSlider.value = String(m);
  if (maxTokensValue) maxTokensValue.textContent = String(m);
}

function handleTemperatureChange(): void {
  if (temperatureSlider && temperatureValue) {
    temperatureValue.textContent = temperatureSlider.value;
  }
}

function handleMaxTokensChange(): void {
  if (maxTokensSlider && maxTokensValue) {
    maxTokensValue.textContent = maxTokensSlider.value;
  }
}

async function handleSaveParameters(): Promise<void> {
  const temperature = parseFloat(temperatureSlider?.value ?? String(DEFAULT_TEMPERATURE));
  const maxTokens = parseInt(maxTokensSlider?.value ?? String(DEFAULT_MAX_TOKENS), 10);
  await chrome.storage.sync.set({ aiTemperature: temperature, aiMaxTokens: maxTokens });
  chrome.runtime.sendMessage({ action: 'updateAIParameters', temperature, maxTokens });
  showParameterStatus('Parameters saved.', 'success');
}

async function handleResetParameters(): Promise<void> {
  if (temperatureSlider) temperatureSlider.value = String(DEFAULT_TEMPERATURE);
  if (temperatureValue) temperatureValue.textContent = String(DEFAULT_TEMPERATURE);
  if (maxTokensSlider) maxTokensSlider.value = String(DEFAULT_MAX_TOKENS);
  if (maxTokensValue) maxTokensValue.textContent = String(DEFAULT_MAX_TOKENS);
  await handleSaveParameters();
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const standardPromptElement = $<HTMLTextAreaElement>('standardPrompt');
const withCommentsPromptElement = $<HTMLTextAreaElement>('withCommentsPrompt');
const savePromptsBtn = $<HTMLButtonElement>('savePrompts');
const resetPromptsBtn = $<HTMLButtonElement>('resetPrompts');
const settingsStatus = $('settingsStatus');

let defaultPrompts = { standard: '', withComments: '' };

function showPromptsStatus(text: string, kind: 'success' | 'error'): void {
  if (!settingsStatus) return;
  settingsStatus.textContent = text;
  settingsStatus.className = `status-message ${kind}`;
  settingsStatus.style.display = '';
  setTimeout(() => {
    if (settingsStatus) settingsStatus.style.display = 'none';
  }, 4000);
}

async function loadPrompts(): Promise<void> {
  const resp = await new Promise<{
    prompts: { standard?: string; withComments?: string };
    defaults: typeof defaultPrompts;
  }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'getPrompts' }, (r) => resolve(r));
  });
  defaultPrompts = resp.defaults;
  if (standardPromptElement) {
    standardPromptElement.value = resp.prompts.standard ?? defaultPrompts.standard;
  }
  if (withCommentsPromptElement) {
    withCommentsPromptElement.value = resp.prompts.withComments ?? defaultPrompts.withComments;
  }
}

async function handleSavePrompts(): Promise<void> {
  const prompts = {
    standard: standardPromptElement?.value.trim() ?? '',
    withComments: withCommentsPromptElement?.value.trim() ?? '',
  };
  const resp = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'savePrompts', prompts }, (r) => resolve(r));
  });
  if (resp.success) showPromptsStatus('Prompts saved.', 'success');
  else showPromptsStatus(`Save failed: ${resp.error ?? 'unknown'}`, 'error');
}

async function handleResetPrompts(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ action: 'resetPrompts' }, () => resolve());
  });
  if (standardPromptElement) standardPromptElement.value = defaultPrompts.standard;
  if (withCommentsPromptElement) withCommentsPromptElement.value = defaultPrompts.withComments;
  showPromptsStatus('Reset to defaults.', 'success');
}

// ─── Today: cadence quotas + recommend cards + streak + pending chips ─────

type Pillar = 'brand' | 'finding' | 'engaging' | 'building';
type WeeklyProgressDto = Record<Pillar, { done: number; target: number; pct: number }>;
interface ActionRowDto {
  id: number;
  type: string;
  pillar: Pillar;
  timestamp: number;
  postId?: string;
  draftText?: string;
  submitted: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const streakCount = $('streakCount');
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cadenceBars = $('cadenceBars');
const pendingChips = $('pendingChips');
const pendingChipsList = $('pendingChipsList');
const topicsRow = $('topicsRow');
const topicsChips = $('topicsChips');
const retroCard = $('retroCard');
const retroText = $('retroText');
const retroDismiss = $<HTMLButtonElement>('retroDismiss');
const suggestPostBtn = $<HTMLButtonElement>('suggestPostBtn');
const postModal = $('postModal');
const postModalClose = $<HTMLButtonElement>('postModalClose');
const postModalBody = $('postModalBody');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function loadPending(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; rows: ActionRowDto[] }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'action.log.pending' }, (r) =>
      resolve(r ?? { ok: false, rows: [] })
    );
  });
  const rows = resp.rows ?? [];
  if (!pendingChips || !pendingChipsList) return;
  if (rows.length === 0) {
    pendingChips.style.display = 'none';
    return;
  }
  pendingChips.style.display = '';
  pendingChipsList.innerHTML = '';
  for (const row of rows.slice(0, 5)) {
    const chip = document.createElement('div');
    chip.className = 'pending-chip';
    const txt = document.createElement('span');
    txt.className = 'pending-chip__text';
    const when = new Date(row.timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    txt.textContent = `${when} · ${row.type}${row.postId ? ' · ' + row.postId.slice(0, 12) : ''}`;
    const up = document.createElement('button');
    up.className = 'pending-chip__btn';
    up.title = 'It worked';
    up.textContent = '👍';
    up.addEventListener('click', () => void recordOutcome(row.id, 'positive', chip));
    const down = document.createElement('button');
    down.className = 'pending-chip__btn';
    down.title = "Didn't work";
    down.textContent = '👎';
    down.addEventListener('click', () => void recordOutcome(row.id, 'negative', chip));
    chip.append(txt, up, down);
    pendingChipsList.append(chip);
  }
}

async function recordOutcome(
  actionId: number,
  verdict: 'positive' | 'negative',
  chip: HTMLElement
): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'action.log.attachOutcome',
        input: { actionId, source: 'manual', manualVerdict: verdict },
      },
      () => resolve()
    );
  });
  chip.remove();
  // Refresh cadence (no change to counts, but streak might shift on outcome boundaries later).
}

/**
 * Issue #16: the Today (cadence) section was removed from popup.html. The
 * background handlers it called (recommender.getCards, recommender.getRetro)
 * have side effects (AI calls, retroLastShown bookkeeping) — firing them
 * on every panel open with no UI to consume the result was wasted compute
 * + drifting state. Keeping the function as a no-op so existing callers
 * (DOMContentLoaded, handleSsiRefresh) don't need to know.
 */
async function loadToday(): Promise<void> {
  // Intentionally no-op. See block comment above.
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderRetro(text: string | null): void {
  if (!retroCard || !retroText) return;
  if (!text) {
    retroCard.style.display = 'none';
    return;
  }
  retroText.textContent = text;
  retroCard.style.display = '';
}

async function handleRetroDismiss(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ action: 'recommender.dismissRetro' }, () => resolve());
  });
  if (retroCard) retroCard.style.display = 'none';
}

// ─── Suggest-a-post modal ─────────────────────────────────────────────────

interface PostDraftDto {
  angle: 'story' | 'hot_take' | 'lesson';
  topic: string;
  body: string;
}

type PostDraftsStateDto =
  | { status: 'idle' }
  | { status: 'inFlight'; startedAt: number }
  | { status: 'ready'; finishedAt: number; drafts: PostDraftDto[] }
  | { status: 'error'; finishedAt: number; error: string };

const POST_DRAFTS_KEY = 'linkmate.recommender.postDrafts.v1';
const POST_DRAFTS_FRESH_MS = 5 * 60 * 1000; // 5 min — show cached drafts on reopen
const POST_DRAFTS_STALE_INFLIGHT_MS = 90 * 1000; // 90s — anything older is orphan

/**
 * Open the modal. Reads persisted state so a re-opened popup picks up an
 * in-flight or completed generation from a previous popup instance.
 * Only kicks off a fresh request if there's nothing fresh to show.
 */
async function openPostModal(): Promise<void> {
  if (!postModal) return;
  postModal.style.display = '';
  const state = await readPostDraftsState();
  renderPostDraftsState(state);
  if (shouldStartFresh(state)) {
    // Reset state then fire-and-forget the message — popup unmount won't lose
    // anything because suggestPosts persists lifecycle to storage.
    await writePostDraftsState({ status: 'inFlight', startedAt: Date.now() });
    chrome.runtime.sendMessage({ action: 'recommender.suggestPosts' });
  }
}

function closePostModal(): void {
  if (postModal) postModal.style.display = 'none';
  clearInFlightWatchdog();
}

function shouldStartFresh(state: PostDraftsStateDto): boolean {
  if (state.status === 'idle') return true;
  if (state.status === 'inFlight') {
    // Re-fire if the previous in-flight is suspiciously old (orphaned by SW eviction).
    return Date.now() - state.startedAt > POST_DRAFTS_STALE_INFLIGHT_MS;
  }
  // ready/error: re-fire only if older than the fresh window
  return Date.now() - state.finishedAt > POST_DRAFTS_FRESH_MS;
}

async function readPostDraftsState(): Promise<PostDraftsStateDto> {
  const { [POST_DRAFTS_KEY]: stored } = await chrome.storage.local.get(POST_DRAFTS_KEY);
  return (stored as PostDraftsStateDto | undefined) ?? { status: 'idle' };
}

async function writePostDraftsState(s: PostDraftsStateDto): Promise<void> {
  await chrome.storage.local.set({ [POST_DRAFTS_KEY]: s });
}

let inFlightWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearInFlightWatchdog(): void {
  if (inFlightWatchdog !== null) {
    clearTimeout(inFlightWatchdog);
    inFlightWatchdog = null;
  }
}

function renderPostDraftsState(state: PostDraftsStateDto): void {
  if (!postModalBody) return;
  postModalBody.innerHTML = '';
  clearInFlightWatchdog();
  if (state.status === 'inFlight') {
    const loading = document.createElement('div');
    loading.className = 'post-modal__loading';
    loading.innerHTML =
      '<i class="fa fa-circle-notch fa-spin"></i> Drafting (this can take 10–30s)…';
    postModalBody.append(loading);
    // Watchdog: MV3 service workers can be evicted mid-call. If the state
    // doesn't move past `inFlight` by the stale threshold, surface an error
    // with retry rather than hanging on the spinner indefinitely.
    const elapsed = Date.now() - state.startedAt;
    const remaining = Math.max(2000, POST_DRAFTS_STALE_INFLIGHT_MS - elapsed);
    inFlightWatchdog = setTimeout(() => {
      void (async () => {
        const fresh = await readPostDraftsState();
        if (fresh.status === 'inFlight') {
          await writePostDraftsState({
            status: 'error',
            finishedAt: Date.now(),
            error: 'Drafting timed out. The background worker may have been evicted — try again.',
          });
        }
      })();
    }, remaining);
    return;
  }
  if (state.status === 'error') {
    const err = document.createElement('div');
    err.className = 'post-modal__error';
    err.textContent = state.error || 'Failed to generate drafts.';
    const retry = document.createElement('button');
    retry.className = 'post-draft__btn';
    retry.style.marginTop = '8px';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => void openPostModal());
    postModalBody.append(err, retry);
    return;
  }
  if (state.status === 'ready') {
    for (const draft of state.drafts) postModalBody.append(buildDraftCard(draft));
    return;
  }
  // idle — open path will start a request next tick
}

function buildDraftCard(draft: PostDraftDto): HTMLElement {
  const card = document.createElement('div');
  card.className = 'post-draft';
  const meta = document.createElement('div');
  meta.className = 'post-draft__meta';
  meta.textContent = `${draft.angle.replace('_', ' ')} · ${draft.topic}`;
  const body = document.createElement('div');
  body.className = 'post-draft__body';
  body.textContent = draft.body;
  const actions = document.createElement('div');
  actions.className = 'post-draft__actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'post-draft__btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(draft.body);
    copyBtn.textContent = 'Copied';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    chrome.runtime.sendMessage({
      action: 'action.log.append',
      input: { type: 'post', draftText: draft.body, submitted: true, sourceText: draft.body },
    });
  });
  const composeBtn = document.createElement('button');
  composeBtn.className = 'post-draft__btn post-draft__btn--secondary';
  composeBtn.textContent = 'Open composer';
  composeBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(draft.body);
    chrome.tabs.create({ url: 'https://www.linkedin.com/feed/?shareActive=true' });
    chrome.runtime.sendMessage({
      action: 'action.log.append',
      input: { type: 'post', draftText: draft.body, submitted: true, sourceText: draft.body },
    });
  });
  actions.append(copyBtn, composeBtn);
  card.append(meta, body, actions);
  return card;
}

/** Live update modal when background writes new state (mid-call → ready/error). */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[POST_DRAFTS_KEY]) return;
  if (!postModal || postModal.style.display === 'none') return;
  const next = changes[POST_DRAFTS_KEY].newValue as PostDraftsStateDto | undefined;
  if (next) renderPostDraftsState(next);
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function loadTopics(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; topics?: Array<{ topic: string; count: number }> }>(
    (resolve) => {
      chrome.runtime.sendMessage({ action: 'action.log.topTopics', days: 14, n: 6 }, (r) =>
        resolve(r ?? { ok: false })
      );
    }
  );
  const topics = resp.topics ?? [];
  if (!topicsRow || !topicsChips) return;
  if (topics.length === 0) {
    topicsRow.style.display = 'none';
    return;
  }
  topicsRow.style.display = '';
  topicsChips.innerHTML = '';
  for (const t of topics) {
    const chip = document.createElement('span');
    chip.className = 'topic-chip';
    const label = document.createTextNode(`${t.topic} `);
    const count = document.createElement('span');
    count.className = 'topic-chip__count';
    count.textContent = String(t.count);
    chip.append(label, count);
    topicsChips.append(chip);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function emptyProgress(): WeeklyProgressDto {
  return {
    brand: { done: 0, target: 1, pct: 0 },
    finding: { done: 0, target: 5, pct: 0 },
    engaging: { done: 0, target: 3, pct: 0 },
    building: { done: 0, target: 2, pct: 0 },
  };
}


// ─── Goals override (issue #18) ────────────────────────────────────────────

const goalsOverrideInput = $<HTMLTextAreaElement>('goalsOverride');
const goalsOverrideCount = $<HTMLElement>('goalsOverrideCount');
const goalsOverrideHint = $<HTMLElement>('goalsOverridePlaceholderHint');
const goalsOverrideSaveBtn = $<HTMLButtonElement>('goalsOverrideSave');
const goalsOverrideStatus = $('goalsOverrideStatus');
const GOALS_OVERRIDE_MAX_LEN_POPUP = 600;

function showGoalsOverrideStatus(text: string, kind: 'success' | 'error'): void {
  if (!goalsOverrideStatus) return;
  goalsOverrideStatus.textContent = text;
  goalsOverrideStatus.className = `status-message ${kind}`;
  goalsOverrideStatus.style.display = '';
  setTimeout(() => {
    if (goalsOverrideStatus) goalsOverrideStatus.style.display = 'none';
  }, 4000);
}

function updateGoalsCount(): void {
  if (!goalsOverrideInput || !goalsOverrideCount) return;
  goalsOverrideCount.textContent = String(goalsOverrideInput.value.length);
}

async function loadGoalsOverride(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; value?: string | null }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'settings.getGoalsOverride' }, (r) =>
      resolve(r ?? { ok: false })
    );
  });
  if (goalsOverrideInput) {
    goalsOverrideInput.value = resp.value ?? '';
    updateGoalsCount();
  }
  // Show the user's positioning summary as a hint of what goals default to.
  try {
    const profile = await getProfile();
    if (goalsOverrideHint && profile?.positioningSummary) {
      goalsOverrideHint.textContent = ` Default: "${profile.positioningSummary.slice(0, 140)}"`;
    }
  } catch {
    /* hint is best-effort */
  }
}

async function handleGoalsOverrideSave(): Promise<void> {
  if (!goalsOverrideInput || !goalsOverrideSaveBtn) return;
  const value = goalsOverrideInput.value.slice(0, GOALS_OVERRIDE_MAX_LEN_POPUP);
  goalsOverrideSaveBtn.disabled = true;
  const prev = goalsOverrideSaveBtn.innerHTML;
  goalsOverrideSaveBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Saving…';
  try {
    const resp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'settings.setGoalsOverride', value }, (r) =>
        resolve(r ?? { ok: false, error: 'No response' })
      );
    });
    if (resp.ok) {
      showGoalsOverrideStatus(
        value.length === 0 ? 'Cleared — using positioning summary.' : 'Saved.',
        'success'
      );
    } else {
      showGoalsOverrideStatus(`Save failed: ${resp.error ?? 'unknown'}`, 'error');
    }
  } finally {
    goalsOverrideSaveBtn.disabled = false;
    goalsOverrideSaveBtn.innerHTML = prev;
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

function wire(): void {
  providerSaveBtn?.addEventListener('click', () => void handleProviderSave());
  captureProfileBtn?.addEventListener('click', () => void handleCaptureProfile());
  captureFullProfileToggle?.addEventListener('change', () => void handleCaptureFullProfileToggle());
  deepScrapeCancelBtn?.addEventListener('click', () => void handleDeepScrapeCancel());
  wireDeepScrapeProgressListener();
  heroRefreshBtn?.addEventListener('click', () => void handleHeroRefresh());
  heroCopyBtn?.addEventListener('click', () => void handleHeroCopyJson());
  ssiRefreshBtn?.addEventListener('click', () => void handleSsiRefresh());
  ssiOpenPageBtn?.addEventListener('click', handleSsiOpenPage);
  temperatureSlider?.addEventListener('input', handleTemperatureChange);
  maxTokensSlider?.addEventListener('input', handleMaxTokensChange);
  saveParametersBtn?.addEventListener('click', () => void handleSaveParameters());
  resetParametersBtn?.addEventListener('click', () => void handleResetParameters());
  savePromptsBtn?.addEventListener('click', () => void handleSavePrompts());
  resetPromptsBtn?.addEventListener('click', () => void handleResetPrompts());
  goalsOverrideInput?.addEventListener('input', updateGoalsCount);
  goalsOverrideSaveBtn?.addEventListener('click', () => void handleGoalsOverrideSave());
  retroDismiss?.addEventListener('click', () => void handleRetroDismiss());
  suggestPostBtn?.addEventListener('click', () => void openPostModal());
  postModalClose?.addEventListener('click', closePostModal);
  postModal?.querySelector('.post-modal__backdrop')?.addEventListener('click', closePostModal);
  profileAuditRewriteBtn?.addEventListener('click', () => void handleProfileAuditRewrite());
  profileAuditRerunBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleProfileAuditRerun();
  });
  profileAuditFilters?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.profile-audit__filter');
    if (!btn) return;
    const f = btn.dataset.filter as 'all' | AuditCategory | undefined;
    if (!f) return;
    setAuditFilter(f);
  });
}

/**
 * Make sure the Post-drafts modal starts hidden, and don't carry an orphaned
 * `inFlight` flag across popup sessions. MV3 service workers can be evicted
 * mid-call, leaving the state stuck — sanitize before any code reads it.
 */
async function sanitizePostDraftsState(): Promise<void> {
  if (postModal) postModal.style.display = 'none';
  const state = await readPostDraftsState();
  if (state.status === 'inFlight' && Date.now() - state.startedAt > POST_DRAFTS_STALE_INFLIGHT_MS) {
    await writePostDraftsState({ status: 'idle' });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  wire();
  await sanitizePostDraftsState();
  await Promise.all([
    loadProviderConfig(),
    refreshProfileDisplay(),
    loadCaptureFullProfileToggle(),
    loadSsiData(),
    loadAIParameters(),
    loadPrompts(),
    loadGoalsOverride(),
    loadToday(),
    loadProfileAudit(),
  ]);
  chrome.runtime.sendMessage({ action: 'popupReady' });
  // Fire-and-forget: don't block the popup paint on a 10–20s capture.
  void maybeAutoCapture();
});
