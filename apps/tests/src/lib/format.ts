/** How the page writes numbers, durations, dates and the names of the targets a test ran on. */

const NUMBER = new Intl.NumberFormat('ja-JP');

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** A duration in milliseconds: `203 ms`, `1.2 s`, `2 分 5 秒`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** The date of a run (`2026-11-07T09:00:09Z` → `2026/11/07 18:00`) in the reader's time zone; empty when it cannot be read. */
export function formatDate(iso: string | undefined): string {
  if (iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The name of a target of a result: Vitest's results have none. */
export function targetLabel(target: string): string {
  if (target === '') return 'Vitest';
  if (target === 'hono') return 'Hono';
  if (target === 'nextjs') return 'Next.js';
  if (target === 'http') return 'HTTP';
  return target;
}

/** A share of a whole in percent, for the widths of the bars (a part above zero is never thinner than a sliver). */
export function share(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  return Math.max((part / whole) * 100, 0.5);
}
