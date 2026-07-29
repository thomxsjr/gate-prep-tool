/** Client plumbing: fetch, routing, keyboard, formatting. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IS_STATIC, staticApi } from './static-mode.ts';

// --- data ------------------------------------------------------------------

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // The deployed build has no server. Reads come from a build-time snapshot;
  // writes throw rather than being accepted and silently dropped.
  if (IS_STATIC) return staticApi<T>(path, init);

  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    const err = new Error(body.error ?? `${res.status} ${res.statusText}`) as Error & { field?: string };
    err.field = body.field;
    throw err;
  }
  return (await res.json()) as T;
}

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Local reads are sub-millisecond, so there is no spinner: `loading` is only
 * true on the very first fetch, and a reload keeps showing the old value
 * rather than flashing empty.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seen = useRef(false);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    api<T>(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        seen.current = true;
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, error, loading: !seen.current && data === null && error === null, reload: () => setTick((t) => t + 1) };
}

// --- routing ---------------------------------------------------------------

export function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/deck');

  useEffect(() => {
    const on = (): void => setRoute(window.location.hash.slice(1) || '/deck');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);

  return [route, navigate];
}

// --- keyboard --------------------------------------------------------------

/** Cmd/Ctrl+Enter submits every form in the app. */
export function useSubmitShortcut(onSubmit: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onSubmit();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onSubmit, enabled]);
}

export function useHotkeys(
  map: Record<string, (e: KeyboardEvent) => void>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const combo = [
        e.metaKey || e.ctrlKey ? 'mod+' : '',
        e.shiftKey && e.key.length > 1 ? 'shift+' : '',
        e.key.toLowerCase(),
      ].join('');

      const handler = map[combo];
      if (!handler) return;
      // Bare letter keys must not fire while typing.
      if (typing && !combo.startsWith('mod+') && e.key !== 'Escape') return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [map, enabled]);
}

/** Arrow-navigable list. Returns the selected index and a keydown handler. */
export function useListNav(
  length: number,
  onEnter?: (i: number) => void,
): { index: number; setIndex: (i: number) => void } {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index >= length) setIndex(Math.max(0, length - 1));
  }, [length, index]);

  useHotkeys(
    {
      arrowdown: () => setIndex((i) => Math.min(length - 1, i + 1)),
      arrowup: () => setIndex((i) => Math.max(0, i - 1)),
      j: () => setIndex((i) => Math.min(length - 1, i + 1)),
      k: () => setIndex((i) => Math.max(0, i - 1)),
      enter: () => onEnter?.(index),
    },
    length > 0,
  );

  return { index, setIndex };
}

// --- formatting ------------------------------------------------------------

/** Fixed 2dp. Numbers must not jitter between renders. */
export const marks = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—.——' : x.toFixed(2);

export const pct = (x: number | null | undefined, dp = 1): string =>
  x === null || x === undefined ? '—.—%' : `${(x * 100).toFixed(dp)}%`;

export const int = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : String(Math.round(x));

export function days(n: number): string {
  if (n === 0) return 'today';
  if (n < 0) return `${Math.abs(n)}d ago`;
  return `${n}d`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function useTimer(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const start = useRef<number>(Date.now());

  useEffect(() => {
    if (!running) return;
    start.current = Date.now() - elapsed * 1000;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start.current) / 1000)), 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return elapsed;
}
