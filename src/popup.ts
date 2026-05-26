'use strict';

import './popup.css';
import { ProfileContextService } from './profile-context';
import {
  renderLatest as renderSsiLatest,
  renderTrend as renderSsiTrend,
  getInsight as getSsiInsight,
} from './ssi-tracker';
import {
  getCaptureFullProfile,
  getSsiLastError,
  setCaptureFullProfile,
} from './storage-schema';
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

/**
 * If the active tab isn't already on a LinkedIn profile, navigate it to
 * /in/me/ (LinkedIn auto-redirects to the user's own handle) and wait until
 * the page is loaded. Returns true once the tab is on a profile URL.
 */
async function ensureOnOwnProfile(): Promise<boolean> {
  const PROFILE_URL_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?[^#]*)?(#.*)?$/;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  if (PROFILE_URL_RE.test(tab.url ?? '')) return true;
  await chrome.tabs.update(tab.id, { url: 'https://www.linkedin.com/in/me/' });
  await new Promise<void>((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
  return true;
}

async function handleCaptureProfile(): Promise<void> {
  if (!captureProfileBtn) return;
  captureProfileBtn.disabled = true;
  const prevText = captureProfileBtn.innerHTML;
  captureProfileBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Capturing…';
  try {
    await ensureOnOwnProfile();
    const result = await profileService.capture();
    if (result.ok) {
      if (result.cached) {
        showProfileMessage('Profile is fresh (<24h). Using cached snapshot.', 'info');
      } else {
        showProfileMessage('Profile captured.', 'success');
      }
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

async function loadCaptureFullProfileToggle(): Promise<void> {
  if (!captureFullProfileToggle) return;
  captureFullProfileToggle.checked = await getCaptureFullProfile();
}

async function handleCaptureFullProfileToggle(): Promise<void> {
  if (!captureFullProfileToggle) return;
  await setCaptureFullProfile(captureFullProfileToggle.checked);
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
const retroCard = $('retroCard');
const retroText = $('retroText');
const retroDismiss = $<HTMLButtonElement>('retroDismiss');
const cardsSource = $('cardsSource');
const cardsRefresh = $<HTMLButtonElement>('cardsRefresh');
const suggestPostBtn = $<HTMLButtonElement>('suggestPostBtn');
const postModal = $('postModal');
const postModalClose = $<HTMLButtonElement>('postModalClose');
const postModalBody = $('postModalBody');
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

interface RecommendCardDto {
  action: string;
  pillar: Pillar;
  title: string;
  reason: string;
  postId?: string;
}
interface RecommenderStateDto {
  generatedAt: number;
  cards: RecommendCardDto[];
  source: 'ai' | 'rule';
}

function cardHrefFor(pillar: Pillar, postId?: string): string {
  if (postId && postId.startsWith('urn:li:activity:')) {
    const id = postId.replace('urn:li:activity:', '');
    return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  }
  return PILLAR_COPY[pillar].href;
}

function renderRecommendations(state: RecommenderStateDto): void {
  if (!recommendCards) return;
  if (cardsSource) {
    cardsSource.textContent =
      state.source === 'ai' ? 'AI · ' + relativeTime(state.generatedAt) : 'Rule-based';
  }
  recommendCards.innerHTML = '';
  for (const c of state.cards) {
    const card = document.createElement('div');
    card.className = 'recommend-card';
    const title = document.createElement('div');
    title.className = 'recommend-card__title';
    title.textContent = c.title;
    const reason = document.createElement('div');
    reason.className = 'recommend-card__reason';
    reason.textContent = c.reason;
    const btn = document.createElement('button');
    btn.className = 'recommend-card__action';
    btn.textContent = PILLAR_COPY[c.pillar].cta;
    btn.addEventListener('click', () => chrome.tabs.create({ url: cardHrefFor(c.pillar, c.postId) }));
    card.append(title, reason, btn);
    recommendCards.append(card);
  }
}

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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
  const [progressResp, streakResp, cardsResp, retroResp] = await Promise.all([
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
    new Promise<{ ok: boolean; state?: RecommenderStateDto }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'recommender.getCards' }, (r) =>
        resolve(r ?? { ok: false }),
      );
    }),
    new Promise<{ ok: boolean; retro?: string | null }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'recommender.getRetro' }, (r) =>
        resolve(r ?? { ok: false }),
      );
    }),
  ]);
  const progress = progressResp.progress ?? emptyProgress();
  const weakest = progressResp.weakest ?? 'engaging';
  renderProgressBars(progress, weakest);
  renderStreak(streakResp.count ?? 0);
  if (cardsResp.state) renderRecommendations(cardsResp.state);
  renderRetro(retroResp.retro ?? null);
  void loadPending();
  void loadTopics();
}

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

async function handleCardsRefresh(): Promise<void> {
  if (!cardsRefresh) return;
  cardsRefresh.disabled = true;
  const prev = cardsRefresh.innerHTML;
  cardsRefresh.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i>';
  try {
    const resp = await new Promise<{ ok: boolean; state?: RecommenderStateDto }>((resolve) => {
      chrome.runtime.sendMessage({ action: 'recommender.refresh' }, (r) =>
        resolve(r ?? { ok: false }),
      );
    });
    if (resp.state) renderRecommendations(resp.state);
  } finally {
    cardsRefresh.disabled = false;
    cardsRefresh.innerHTML = prev;
  }
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
  captureFullProfileToggle?.addEventListener('change', () => void handleCaptureFullProfileToggle());
  ssiRefreshBtn?.addEventListener('click', () => void handleSsiRefresh());
  ssiOpenPageBtn?.addEventListener('click', handleSsiOpenPage);
  temperatureSlider?.addEventListener('input', handleTemperatureChange);
  maxTokensSlider?.addEventListener('input', handleMaxTokensChange);
  saveParametersBtn?.addEventListener('click', () => void handleSaveParameters());
  resetParametersBtn?.addEventListener('click', () => void handleResetParameters());
  savePromptsBtn?.addEventListener('click', () => void handleSavePrompts());
  resetPromptsBtn?.addEventListener('click', () => void handleResetPrompts());
  cadenceSaveBtn?.addEventListener('click', () => void handleCadenceSave());
  retroDismiss?.addEventListener('click', () => void handleRetroDismiss());
  cardsRefresh?.addEventListener('click', () => void handleCardsRefresh());
  suggestPostBtn?.addEventListener('click', () => void openPostModal());
  postModalClose?.addEventListener('click', closePostModal);
  postModal?.querySelector('.post-modal__backdrop')?.addEventListener('click', closePostModal);
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
    loadCadenceTargets(),
    loadToday(),
  ]);
  chrome.runtime.sendMessage({ action: 'popupReady' });
});
