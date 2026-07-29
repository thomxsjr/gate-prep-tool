import { useEffect, useMemo, useState } from 'react';
import { useApi, useHotkeys, useRoute } from './lib.ts';
import { IS_STATIC, snapshotGeneratedAt } from './static-mode.ts';
import { Deck } from './pages/Deck.tsx';
import { Errors } from './pages/Errors.tsx';
import { Review } from './pages/Review.tsx';
import { Msq } from './pages/Msq.tsx';
import { Drills } from './pages/Drills.tsx';
import { Mocks } from './pages/Mocks.tsx';
import { Calibration } from './pages/Calibration.tsx';
import { Cards } from './pages/Cards.tsx';
import { Formula } from './pages/Formula.tsx';
import { Pyq } from './pages/Pyq.tsx';
import { Weekly } from './pages/Weekly.tsx';
import { Settings } from './pages/Settings.tsx';

interface NavItem {
  path: string;
  label: string;
  key: string;
  hint: string;
}

const NAV: NavItem[] = [
  { path: '/deck', label: 'Deck', key: 'g d', hint: 'Ladder and procedural share' },
  { path: '/errors', label: 'Error log', key: 'g e', hint: 'Capture and triage' },
  { path: '/review', label: 'Review', key: 'g r', hint: 'Full-screen morning review' },
  { path: '/msq', label: 'MSQ', key: 'g m', hint: 'Per-option verdict trainer' },
  { path: '/drills', label: 'Drills', key: 'g b', hint: 'Boundary drill, rapid fire' },
  { path: '/mocks', label: 'Mocks', key: 'g k', hint: 'Import and blocking triage' },
  { path: '/calibration', label: 'Calibration', key: 'g c', hint: 'Confidence vs accuracy' },
  { path: '/cards', label: 'Cards', key: 'g f', hint: 'Spaced repetition' },
  { path: '/formula', label: 'Formula', key: 'g s', hint: 'Anchor sheet and recall test' },
  { path: '/pyq', label: 'PYQ', key: 'g p', hint: 'Coverage grid and revisits' },
  { path: '/weekly', label: 'Weekly', key: 'g w', hint: 'Sunday one-pager' },
  { path: '/settings', label: 'Settings', key: 'g ,', hint: 'Dates, gates, rungs, marking' },
];

export function App(): React.ReactElement {
  const [route, navigate] = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const health = useApi<{ counts: Record<string, number> }>('/health');

  useHotkeys({
    'mod+k': () => setPaletteOpen((o) => !o),
    escape: () => setPaletteOpen(false),
  });

  const page = route.split('?')[0] ?? '/deck';

  return (
    <div className="min-h-screen">
      <Nav current={page} navigate={navigate} onPalette={() => setPaletteOpen(true)} />

      <main className="mx-auto max-w-[1500px] px-4 pt-3 pb-10">
        {IS_STATIC && <SnapshotBanner />}
        {!IS_STATIC && health.error && (
          <p className="mb-3 border border-procedural bg-panel p-3 text-sm text-procedural">
            API unreachable: {health.error}. Start it with <code>npm run api</code>.
          </p>
        )}
        <Page route={route} navigate={navigate} />
      </main>

      {paletteOpen && <Palette navigate={navigate} close={() => setPaletteOpen(false)} />}
    </div>
  );
}

function SnapshotBanner(): React.ReactElement {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    void snapshotGeneratedAt().then(setAt).catch(() => setAt(null));
  }, []);

  return (
    <p className="mb-3 border border-rule bg-panel px-3 py-2 text-[12px] leading-relaxed print:hidden">
      <strong className="tracking-[0.14em] uppercase">Read-only snapshot</strong>
      {at && <span className="num text-ink-muted"> · frozen {at.slice(0, 16).replace('T', ' ')} UTC</span>}
      <span className="text-ink-muted">
        {' '}— for revising on a phone. Capture, triage, card review and mock entry live on the
        machine running the app, where writes are journalled and provably restorable. Boundary
        drills work here in full; only their recording does not.
      </span>
    </p>
  );
}

function Page({ route, navigate }: { route: string; navigate: (to: string) => void }): React.ReactElement {
  const [path, query] = route.split('?');
  const params = new URLSearchParams(query ?? '');

  switch (path) {
    case '/errors': return <Errors navigate={navigate} params={params} />;
    case '/review': return <Review />;
    case '/msq': return <Msq />;
    case '/drills': return <Drills />;
    case '/mocks': return <Mocks navigate={navigate} params={params} />;
    case '/calibration': return <Calibration />;
    case '/cards': return <Cards />;
    case '/formula': return <Formula />;
    case '/pyq': return <Pyq navigate={navigate} />;
    case '/weekly': return <Weekly />;
    case '/settings': return <Settings />;
    default: return <Deck navigate={navigate} />;
  }
}

function Nav({
  current,
  navigate,
  onPalette,
}: {
  current: string;
  navigate: (to: string) => void;
  onPalette: () => void;
}): React.ReactElement {
  return (
    <nav className="sticky top-0 z-10 border-b border-rule bg-ground/95 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-[1500px] items-center gap-1 overflow-x-auto px-4 py-1.5">
        <span className="num mr-3 shrink-0 text-[11px] font-semibold tracking-[0.2em] uppercase">
          GATE DA 27
        </span>
        {NAV.map((n) => (
          <button
            key={n.path}
            onClick={() => navigate(n.path)}
            aria-current={current === n.path ? 'page' : undefined}
            className={`shrink-0 border-b-2 px-2 py-1 text-xs tracking-wide whitespace-nowrap transition-colors ${
              current === n.path
                ? 'border-ink font-semibold'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {n.label}
          </button>
        ))}
        <button
          onClick={onPalette}
          className="num ml-auto shrink-0 border border-rule px-2 py-1 text-[10px] text-ink-muted hover:border-ink hover:text-ink"
        >
          ⌘K
        </button>
      </div>
    </nav>
  );
}

interface Command {
  label: string;
  hint: string;
  run: () => void;
}

function Palette({
  navigate,
  close,
}: {
  navigate: (to: string) => void;
  close: () => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);

  const commands: Command[] = useMemo(
    () => [
      ...NAV.map((n) => ({
        label: n.label,
        hint: n.hint,
        run: () => navigate(n.path),
      })),
      { label: 'Capture an error', hint: 'New error-log entry', run: () => navigate('/errors?tab=capture') },
      { label: 'Triage queue', hint: 'Diagnose captured errors', run: () => navigate('/errors?tab=queue') },
      { label: 'Leak table', hint: 'Marks lost per error class', run: () => navigate('/errors?tab=leak') },
      { label: 'Browse the error log', hint: 'Filter by class, subject, rung', run: () => navigate('/errors?tab=log') },
      { label: 'Import CSV', hint: 'Bring your own error data', run: () => navigate('/errors?tab=import') },
      { label: 'Start a boundary drill', hint: 'Rapid fire', run: () => navigate('/drills') },
      { label: 'Import a mock', hint: 'Enter rows, then triage', run: () => navigate('/mocks?new=1') },
      { label: 'Export weekly review', hint: 'Markdown', run: () => window.open('/api/weekly.md', '_blank') },
      { label: 'Print formula sheet', hint: 'Anchor sheet as PDF', run: () => navigate('/formula') },
    ],
    [navigate],
  );

  const filtered = commands.filter(
    (c) =>
      q.trim() === '' ||
      `${c.label} ${c.hint}`.toLowerCase().includes(q.toLowerCase().trim()),
  );
  const selected = Math.min(index, Math.max(0, filtered.length - 1));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[12vh]"
      onClick={close}
    >
      <div
        className="w-full max-w-lg border border-ink bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          placeholder="Command…"
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(filtered.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter') {
              e.preventDefault();
              filtered[selected]?.run();
              close();
            }
            if (e.key === 'Escape') close();
          }}
          className="w-full border-b border-rule bg-transparent px-3 py-2.5 text-sm outline-none"
        />
        <ul className="max-h-80 overflow-y-auto">
          {filtered.map((c, i) => (
            <li key={c.label}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  c.run();
                  close();
                }}
                className={`flex w-full items-baseline justify-between px-3 py-1.5 text-left text-sm ${
                  i === selected ? 'bg-ink text-panel' : ''
                }`}
              >
                <span>{c.label}</span>
                <span className={`text-[11px] ${i === selected ? 'text-panel/70' : 'text-ink-muted'}`}>
                  {c.hint}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-ink-muted">No command matches.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
