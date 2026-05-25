import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  bumpProgress,
  getAll,
  setSettings,
  tunedTargets,
  weakestPillar,
} from '../../lib/storage';
import type {
  DailyProgress,
  DailyTargets,
  ProfileAudit,
  Settings,
  SsiSample,
  StoreShape,
} from '../../lib/types';

type Tab = 'today' | 'trend' | 'audit' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [store, setStore] = useState<StoreShape | null>(null);

  useEffect(() => {
    void getAll().then(setStore);
    const onChange = () => void getAll().then(setStore);
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  if (!store) return <div className="p-4 text-ssi-mute">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-ssi-brand" />
          <h1 className="text-lg font-semibold">LinkMate</h1>
        </div>
        <nav className="flex gap-1 text-sm">
          <TabBtn active={tab === 'today'} onClick={() => setTab('today')}>Today</TabBtn>
          <TabBtn active={tab === 'trend'} onClick={() => setTab('trend')}>Trend</TabBtn>
          <TabBtn active={tab === 'audit'} onClick={() => setTab('audit')}>Audit</TabBtn>
          <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>Settings</TabBtn>
        </nav>
      </header>
      <main className="flex-1 overflow-auto p-4">
        {tab === 'today' && (
          <Today
            latest={store.ssiHistory.at(-1)}
            targets={store.dailyTargets}
            progress={store.dailyProgress}
          />
        )}
        {tab === 'trend' && <Trend history={store.ssiHistory} />}
        {tab === 'audit' && <AuditView audit={store.profileAudit} />}
        {tab === 'settings' && (
          <SettingsForm
            value={store.settings}
            onSave={async (s) => {
              await setSettings(s);
            }}
          />
        )}
      </main>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 ${active ? 'bg-ssi-brand text-white' : 'text-ssi-mute hover:bg-gray-100'}`}
    >
      {children}
    </button>
  );
}

const PILLAR_LABELS: Record<string, string> = {
  brand: 'Brand',
  finding: 'Finding people',
  engaging: 'Engaging',
  building: 'Relationships',
};

function Today({
  latest,
  targets,
  progress,
}: {
  latest: SsiSample | undefined;
  targets: DailyTargets;
  progress: DailyProgress;
}) {
  const tuned = tunedTargets(targets, latest);
  const weakest = latest ? weakestPillar(latest) : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-ssi-mute">SSI today</div>
            <div className="mt-1 text-4xl font-bold">
              {latest ? latest.total.toFixed(0) : '—'}
            </div>
          </div>
          {weakest && (
            <div className="text-right text-sm">
              <div className="text-ssi-mute">Weakest pillar</div>
              <div className="font-medium">{PILLAR_LABELS[weakest]}</div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border p-4">
        <div className="mb-3 text-sm font-medium">Today's checklist</div>
        <ul className="space-y-2">
          <ChecklistRow label="Likes" target={tuned.likes} done={progress.likes} k="likes" />
          <ChecklistRow label="Comments" target={tuned.comments} done={progress.comments} k="comments" />
          <ChecklistRow label="Posts" target={tuned.posts} done={progress.posts} k="posts" />
          <ChecklistRow label="Courses" target={tuned.courses} done={progress.courses} k="courses" />
        </ul>
        {weakest && (
          <p className="mt-3 text-xs text-ssi-mute">
            Targets auto-tuned to boost <span className="font-medium">{PILLAR_LABELS[weakest]}</span>.
          </p>
        )}
      </div>
    </div>
  );
}

function ChecklistRow({
  label,
  target,
  done,
  k,
}: {
  label: string;
  target: number;
  done: number;
  k: keyof Omit<DailyProgress, 'date'>;
}) {
  const pct = target === 0 ? 100 : Math.min(100, Math.round((done / target) * 100));
  const complete = target > 0 && done >= target;
  return (
    <li className="rounded border p-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-ssi-mute">
          {done} / {target}
        </div>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-100">
        <div
          className={`h-full ${complete ? 'bg-green-500' : 'bg-ssi-brand'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => void bumpProgress(k)}
          disabled={target === 0}
          className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          +1 done
        </button>
      </div>
    </li>
  );
}

function Trend({ history }: { history: SsiSample[] }) {
  if (history.length === 0) {
    return (
      <div className="rounded border border-dashed p-6 text-center text-ssi-mute">
        Visit{' '}
        <a
          className="text-ssi-brand underline"
          href="https://www.linkedin.com/sales/ssi"
          target="_blank"
          rel="noreferrer"
        >
          linkedin.com/sales/ssi
        </a>{' '}
        to capture your first score.
      </div>
    );
  }
  const latest = history.at(-1)!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2 text-center">
        {(['brand', 'finding', 'engaging', 'building'] as const).map((k) => (
          <div key={k} className="rounded bg-gray-50 py-2">
            <div className="text-xs text-ssi-mute">{PILLAR_LABELS[k]}</div>
            <div className="text-lg font-semibold">{latest[k].toFixed(0)}</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border p-3">
        <div className="mb-2 text-sm font-medium">SSI trend</div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={11} />
              <YAxis domain={[0, 100]} fontSize={11} />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#0a66c2" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function AuditView({ audit }: { audit: ProfileAudit | null }) {
  if (!audit) {
    return (
      <div className="rounded border border-dashed p-6 text-center text-ssi-mute">
        Visit your own LinkedIn profile (linkedin.com/in/&lt;you&gt;) to run an audit.
      </div>
    );
  }
  const color =
    audit.score >= 80 ? 'text-green-600' : audit.score >= 50 ? 'text-amber-600' : 'text-red-600';
  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4">
        <div className="text-xs uppercase tracking-wide text-ssi-mute">Profile completeness</div>
        <div className={`mt-1 text-4xl font-bold ${color}`}>{audit.score}</div>
        <div className="mt-1 text-xs text-ssi-mute">Last run: {audit.lastRun}</div>
      </div>
      <div className="rounded-xl border p-4">
        <div className="mb-2 text-sm font-medium">
          {audit.missing.length === 0 ? 'All checks pass 🎉' : 'Missing'}
        </div>
        {audit.missing.length > 0 && (
          <ul className="space-y-1 text-sm">
            {audit.missing.map((m) => (
              <li key={m} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SettingsForm({ value, onSave }: { value: Settings; onSave: (s: Settings) => void }) {
  const [key, setKey] = useState(value.openaiApiKey);
  const [model, setModel] = useState(value.model);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ openaiApiKey: key.trim(), model: model.trim() || 'gpt-4o-mini' });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
    >
      <div>
        <label className="block text-sm font-medium">OpenAI API key</label>
        <input
          type="password"
          className="mt-1 w-full rounded border px-3 py-2 text-sm"
          placeholder="sk-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <p className="mt-1 text-xs text-ssi-mute">
          Stored locally only (chrome.storage.local). Never synced.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium">Model</label>
        <input
          className="mt-1 w-full rounded border px-3 py-2 text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <button
        type="submit"
        className="rounded bg-ssi-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        {saved ? 'Saved' : 'Save'}
      </button>
    </form>
  );
}
