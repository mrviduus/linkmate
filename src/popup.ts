'use strict';

import './popup.css';
import { ProfileContextService } from './profile-context';
import {
  renderLatest as renderSsiLatest,
  renderTrend as renderSsiTrend,
  getInsight as getSsiInsight,
} from './ssi-tracker';
import { getSsiLastError } from './storage-schema';
import type { ProfileContext, SsiSnapshot } from './storage-schema';

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ─── Provider (OpenAI) ──────────────────────────────────────────────────────

interface ProviderConfigDTO {
  mode: 'openai';
  openai?: { apiKey: string; model: string; baseUrl?: string };
}

const providerOpenAIKeyInput = $<HTMLInputElement>('providerOpenAIKey');
const providerOpenAIModelSelect = $<HTMLSelectElement>('providerOpenAIModel');
const providerSaveBtn = $<HTMLButtonElement>('providerSave');
const providerStatus = $('providerStatus');

function showProviderMessage(text: string, kind: 'success' | 'error' | 'info'): void {
  if (!providerStatus) return;
  providerStatus.textContent = text;
  providerStatus.className = `status-message ${kind}`;
  providerStatus.style.display = '';
  setTimeout(() => {
    if (providerStatus) providerStatus.style.display = 'none';
  }, 6000);
}

function renderProviderForm(cfg: ProviderConfigDTO): void {
  if (providerOpenAIKeyInput) providerOpenAIKeyInput.value = cfg.openai?.apiKey ?? '';
  if (providerOpenAIModelSelect && cfg.openai?.model) {
    const exists = Array.from(providerOpenAIModelSelect.options).some(
      (o) => o.value === cfg.openai!.model,
    );
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = cfg.openai.model;
      opt.textContent = `${cfg.openai.model} (custom)`;
      providerOpenAIModelSelect.appendChild(opt);
    }
    providerOpenAIModelSelect.value = cfg.openai.model;
  }
}

async function loadProviderConfig(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; config?: ProviderConfigDTO }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'provider.get' }, (r) => resolve(r ?? { ok: false }));
  });
  const cfg = resp.config ?? { mode: 'openai', openai: { apiKey: '', model: 'gpt-4o-mini' } };
  renderProviderForm(cfg);
}

async function handleProviderSave(): Promise<void> {
  if (!providerSaveBtn) return;
  const apiKey = providerOpenAIKeyInput?.value.trim() ?? '';
  const model = providerOpenAIModelSelect?.value ?? 'gpt-4o-mini';
  if (!apiKey) {
    showProviderMessage('API key is required.', 'error');
    return;
  }
  providerSaveBtn.disabled = true;
  const prev = providerSaveBtn.innerHTML;
  providerSaveBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Saving…';
  try {
    const resp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'provider.set', config: { mode: 'openai', openai: { apiKey, model } } },
        (r) => resolve(r ?? { ok: false, error: 'No response from background' }),
      );
    });
    if (resp.ok) {
      showProviderMessage(`Saved. Using ${model}.`, 'success');
    } else {
      showProviderMessage(`Save failed: ${resp.error ?? 'unknown'}`, 'error');
    }
  } finally {
    providerSaveBtn.disabled = false;
    providerSaveBtn.innerHTML = prev;
  }
}

// ─── Profile Context ────────────────────────────────────────────────────────

const captureProfileBtn = $<HTMLButtonElement>('captureProfile');
const openMyProfileBtn = $<HTMLButtonElement>('openMyProfile');
const profileNoneState = $('profileNoneState');
const profileCapturedState = $('profileCapturedState');
const profileFullName = $('profileFullName');
const profileHeadline = $('profileHeadline');
const profilePositioning = $('profilePositioning');
const profileCapturedAt = $('profileCapturedAt');
const profileSkillsCount = $('profileSkillsCount');
const profileStaleChip = $('profileStaleChip');
const profileMessage = $('profileMessage');
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
}

async function handleCaptureProfile(): Promise<void> {
  if (!captureProfileBtn) return;
  captureProfileBtn.disabled = true;
  const prevText = captureProfileBtn.innerHTML;
  captureProfileBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Capturing…';
  try {
    const result = await profileService.capture();
    if (result.ok) {
      showProfileMessage('Profile captured.', 'success');
      await refreshProfileDisplay();
    } else {
      showProfileMessage(result.message, 'error');
    }
  } catch (err) {
    showProfileMessage(`Unexpected error: ${String(err)}`, 'error');
  } finally {
    captureProfileBtn.disabled = false;
    captureProfileBtn.innerHTML = prevText;
  }
}

function handleOpenMyProfile(): void {
  chrome.tabs.update({ url: 'https://www.linkedin.com/in/me/' });
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Chart class via dynamic import
let cachedChartCtor: any = null;

async function loadChartCtor(): Promise<unknown> {
  if (!cachedChartCtor) {
    const mod = await import('./chart-loader');
    cachedChartCtor = mod.Chart;
  }
  return cachedChartCtor;
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
  const resp = await new Promise<{ prompts: { standard?: string; withComments?: string }; defaults: typeof defaultPrompts }>((resolve) => {
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

const streakCount = $('streakCount');
const cadenceBars = $('cadenceBars');
const recommendCards = $('recommendCards');
const pendingChips = $('pendingChips');
const pendingChipsList = $('pendingChipsList');
const topicsRow = $('topicsRow');
const topicsChips = $('topicsChips');
const cadenceSaveBtn = $<HTMLButtonElement>('cadenceSaveBtn');
const cadenceStatus = $('cadenceStatus');
const targetBrand = $<HTMLInputElement>('targetBrand');
const targetFinding = $<HTMLInputElement>('targetFinding');
const targetEngaging = $<HTMLInputElement>('targetEngaging');
const targetBuilding = $<HTMLInputElement>('targetBuilding');

const PILLAR_COPY: Record<Pillar, { label: string; cta: string; href: string; reason: string }> = {
  brand: {
    label: 'Publish a post',
    cta: 'Open composer',
    href: 'https://www.linkedin.com/feed/?shareActive=true',
    reason: 'Brand pillar — original posts move it most.',
  },
  finding: {
    label: 'Send connection invites',
    cta: 'Open My Network',
    href: 'https://www.linkedin.com/mynetwork/grow/',
    reason: 'Finding pillar — outbound invites the only signal LinkedIn rewards.',
  },
  engaging: {
    label: 'Comment on a relevant post',
    cta: 'Open feed',
    href: 'https://www.linkedin.com/feed/',
    reason: 'Engaging pillar — thoughtful comments outperform reactions 3-to-1.',
  },
  building: {
    label: 'Reply in a comment thread',
    cta: 'Open feed',
    href: 'https://www.linkedin.com/feed/',
    reason: 'Building pillar — back-and-forth replies signal real relationships.',
  },
};

function renderProgressBars(progress: WeeklyProgressDto, weakest: Pillar): void {
  if (!cadenceBars) return;
  const rows = cadenceBars.querySelectorAll<HTMLElement>('.cadence-row');
  rows.forEach((row) => {
    const pillar = row.getAttribute('data-pillar') as Pillar;
    const p = progress[pillar];
    const fill = row.querySelector<HTMLElement>('.cadence-fill');
    const num = row.querySelector<HTMLElement>('.cadence-num');
    if (fill) fill.style.width = `${p.pct}%`;
    if (num) num.textContent = `${p.done} / ${p.target}`;
    row.classList.toggle('weakest', pillar === weakest);
    row.classList.toggle('complete', p.target > 0 && p.done >= p.target);
  });
}

function renderStreak(count: number): void {
  if (streakCount) streakCount.textContent = String(count);
}

function renderRecommendations(weakest: Pillar, progress: WeeklyProgressDto): void {
  if (!recommendCards) return;
  // Pick 3 cards: weakest pillar first, then next-weakest two.
  const order: Pillar[] = ['brand', 'finding', 'engaging', 'building'].sort((a, b) => {
    if (a === weakest) return -1;
    if (b === weakest) return 1;
    return progress[a as Pillar].pct - progress[b as Pillar].pct;
  }) as Pillar[];
  const pick = order.slice(0, 3);
  recommendCards.innerHTML = '';
  for (const pillar of pick) {
    const copy = PILLAR_COPY[pillar];
    const p = progress[pillar];
    const remaining = Math.max(0, p.target - p.done);
    const card = document.createElement('div');
    card.className = 'recommend-card';
    const title = document.createElement('div');
    title.className = 'recommend-card__title';
    title.textContent = remaining > 0 ? `${copy.label} (${remaining} to go this week)` : copy.label;
    const reason = document.createElement('div');
    reason.className = 'recommend-card__reason';
    reason.textContent = copy.reason;
    const btn = document.createElement('button');
    btn.className = 'recommend-card__action';
    btn.textContent = copy.cta;
    btn.addEventListener('click', () => chrome.tabs.create({ url: copy.href }));
    card.append(title, reason, btn);
    recommendCards.append(card);
  }
}

async function loadPending(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; rows: ActionRowDto[] }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'action.log.pending' }, (r) =>
      resolve(r ?? { ok: false, rows: [] }),
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
    up.addEventListener('click', () =>
      void recordOutcome(row.id, 'positive', chip),
    );
    const down = document.createElement('button');
    down.className = 'pending-chip__btn';
    down.title = "Didn't work";
    down.textContent = '👎';
    down.addEventListener('click', () =>
      void recordOutcome(row.id, 'negative', chip),
    );
    chip.append(txt, up, down);
    pendingChipsList.append(chip);
  }
}

async function recordOutcome(
  actionId: number,
  verdict: 'positive' | 'negative',
  chip: HTMLElement,
): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'action.log.attachOutcome',
        input: { actionId, source: 'manual', manualVerdict: verdict },
      },
      () => resolve(),
    );
  });
  chip.remove();
  // Refresh cadence (no change to counts, but streak might shift on outcome boundaries later).
}

async function loadToday(): Promise<void> {
  const [progressResp, streakResp] = await Promise.all([
    new Promise<{ ok: boolean; progress: WeeklyProgressDto; weakest: Pillar }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'action.log.weeklyProgress' }, (r) =>
        resolve(r ?? { ok: false, progress: emptyProgress(), weakest: 'engaging' }),
      );
    }),
    new Promise<{ ok: boolean; count: number }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'cadence.streak' }, (r) =>
        resolve(r ?? { ok: false, count: 0 }),
      );
    }),
  ]);
  const progress = progressResp.progress ?? emptyProgress();
  const weakest = progressResp.weakest ?? 'engaging';
  renderProgressBars(progress, weakest);
  renderStreak(streakResp.count ?? 0);
  renderRecommendations(weakest, progress);
  void loadPending();
  void loadTopics();
}

async function loadTopics(): Promise<void> {
  const resp = await new Promise<{ ok: boolean; topics?: Array<{ topic: string; count: number }> }>(
    (resolve) => {
      chrome.runtime.sendMessage({ action: 'action.log.topTopics', days: 14, n: 6 }, (r) =>
        resolve(r ?? { ok: false }),
      );
    },
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

function emptyProgress(): WeeklyProgressDto {
  return {
    brand: { done: 0, target: 1, pct: 0 },
    finding: { done: 0, target: 5, pct: 0 },
    engaging: { done: 0, target: 3, pct: 0 },
    building: { done: 0, target: 2, pct: 0 },
  };
}

// ─── Weekly targets form ──────────────────────────────────────────────────

function showCadenceStatus(text: string, kind: 'success' | 'error'): void {
  if (!cadenceStatus) return;
  cadenceStatus.textContent = text;
  cadenceStatus.className = `status-message ${kind}`;
  cadenceStatus.style.display = '';
  setTimeout(() => {
    if (cadenceStatus) cadenceStatus.style.display = 'none';
  }, 3000);
}

async function loadCadenceTargets(): Promise<void> {
  const resp = await new Promise<{
    ok: boolean;
    targets: { brand: number; finding: number; engaging: number; building: number };
  }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'cadence.getTargets' }, (r) =>
      resolve(r ?? { ok: false, targets: { brand: 1, finding: 5, engaging: 3, building: 2 } }),
    );
  });
  const t = resp.targets;
  if (targetBrand) targetBrand.value = String(t.brand);
  if (targetFinding) targetFinding.value = String(t.finding);
  if (targetEngaging) targetEngaging.value = String(t.engaging);
  if (targetBuilding) targetBuilding.value = String(t.building);
}

async function handleCadenceSave(): Promise<void> {
  const targets = {
    brand: parseInt(targetBrand?.value ?? '1', 10),
    finding: parseInt(targetFinding?.value ?? '5', 10),
    engaging: parseInt(targetEngaging?.value ?? '3', 10),
    building: parseInt(targetBuilding?.value ?? '2', 10),
  };
  const resp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'cadence.setTargets', targets }, (r) =>
      resolve(r ?? { ok: false, error: 'No response' }),
    );
  });
  if (resp.ok) {
    showCadenceStatus('Saved.', 'success');
    void loadToday();
  } else {
    showCadenceStatus(`Save failed: ${resp.error ?? 'unknown'}`, 'error');
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

function wire(): void {
  providerSaveBtn?.addEventListener('click', () => void handleProviderSave());
  captureProfileBtn?.addEventListener('click', () => void handleCaptureProfile());
  openMyProfileBtn?.addEventListener('click', handleOpenMyProfile);
  ssiRefreshBtn?.addEventListener('click', () => void handleSsiRefresh());
  ssiOpenPageBtn?.addEventListener('click', handleSsiOpenPage);
  temperatureSlider?.addEventListener('input', handleTemperatureChange);
  maxTokensSlider?.addEventListener('input', handleMaxTokensChange);
  saveParametersBtn?.addEventListener('click', () => void handleSaveParameters());
  resetParametersBtn?.addEventListener('click', () => void handleResetParameters());
  savePromptsBtn?.addEventListener('click', () => void handleSavePrompts());
  resetPromptsBtn?.addEventListener('click', () => void handleResetPrompts());
  cadenceSaveBtn?.addEventListener('click', () => void handleCadenceSave());
}

document.addEventListener('DOMContentLoaded', async () => {
  wire();
  await Promise.all([
    loadProviderConfig(),
    refreshProfileDisplay(),
    loadSsiData(),
    loadAIParameters(),
    loadPrompts(),
    loadCadenceTargets(),
    loadToday(),
  ]);
  chrome.runtime.sendMessage({ action: 'popupReady' });
});
