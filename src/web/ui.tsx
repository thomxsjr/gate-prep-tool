/**
 * Instrument primitives.
 *
 * Panels are defined by hairlines and background shifts — no shadows, no
 * rounded corners beyond 2px, no gaps that read as widgets. High information
 * density is the point.
 *
 * Colour rule: `--color-procedural` means "this was a process failure" and
 * appears nowhere else. Progress is ink, never green.
 */

import { forwardRef, type ReactNode } from 'react';

export function Panel({
  label,
  right,
  children,
  className = '',
  pad = true,
}: {
  label?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}): React.ReactElement {
  return (
    <section className={`border border-rule bg-panel ${className}`}>
      {label && (
        <header className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
          <h2 className="text-[10px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
            {label}
          </h2>
          {right && <div className="num text-[11px] text-ink-muted">{right}</div>}
        </header>
      )}
      <div className={pad ? 'p-3' : ''}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  sub,
  size = 'md',
  alarm = false,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  alarm?: boolean;
}): React.ReactElement {
  const sizes = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-4xl',
    xl: 'text-6xl',
  } as const;
  return (
    <div>
      <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">{label}</div>
      <div
        className={`num ${sizes[size]} leading-none font-medium tabular-nums ${alarm ? 'text-procedural' : ''}`}
      >
        {value}
      </div>
      {sub && <div className="num mt-1 text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

export function Rule(): React.ReactElement {
  return <hr className="border-0 border-t border-rule" />;
}

/** Status without a second colour: ink weight and hatching carry meaning. */
export function Status({ status }: { status: string }): React.ReactElement {
  const map: Record<string, { text: string; className: string }> = {
    met: { text: 'met', className: 'text-ink font-semibold' },
    on_track: { text: 'on track', className: 'text-ink' },
    at_risk: { text: 'at risk', className: 'text-ink font-semibold underline decoration-dotted underline-offset-4' },
    missed: { text: 'missed', className: 'text-procedural font-semibold' },
    unknown: { text: 'no data', className: 'text-ink-muted' },
  };
  const s = map[status] ?? map['unknown']!;
  return <span className={`text-[11px] tracking-wide uppercase ${s.className}`}>{s.text}</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">{label}</span>
        {hint && <span className="num text-[10px] text-ink-muted">{hint}</span>}
      </div>
      <div className="mt-1">{children}</div>
      {error && <div className="mt-1 text-[11px] text-procedural">{error}</div>}
    </label>
  );
}

const inputBase =
  'w-full border border-rule bg-ground px-2 py-1.5 text-sm outline-none focus:border-ink';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={`${inputBase} ${props.className ?? ''}`} />;
  },
);

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
): React.ReactElement {
  return <textarea {...props} className={`${inputBase} resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return <select {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Button({
  children,
  variant = 'default',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet';
}): React.ReactElement {
  const styles = {
    default: 'border-rule bg-panel hover:border-ink',
    primary: 'border-ink bg-ink text-panel hover:bg-ink/90',
    quiet: 'border-transparent text-ink-muted hover:text-ink',
  } as const;
  return (
    <button
      {...rest}
      className={`border px-3 py-1.5 text-xs tracking-wide uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${styles[variant]} ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

/** Marks a value as coming from a process failure. The one use of the hue. */
export function Procedural({ children }: { children: ReactNode }): React.ReactElement {
  return <span className="text-procedural">{children}</span>;
}

export function Empty({ children }: { children: ReactNode }): React.ReactElement {
  return <p className="px-1 py-6 text-center text-sm text-ink-muted">{children}</p>;
}

export function Table({
  head,
  children,
}: {
  head: ReactNode[];
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule">
            {head.map((h, i) => (
              <th
                key={i}
                className={`px-2 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-ink-muted uppercase ${
                  i === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  align = 'right',
  className = '',
  colSpan,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  colSpan?: number;
}): React.ReactElement {
  return (
    <td
      colSpan={colSpan}
      className={`num px-2 py-1.5 ${align === 'left' ? 'text-left' : 'text-right'} ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * Sparkline. Gaps in the series are real gaps — a week with no qualifying
 * work is missing data, and joining across it would draw a trend that never
 * happened.
 */
export function Sparkline({
  values,
  width = 180,
  height = 34,
  baseline,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  baseline?: number;
}): React.ReactElement {
  const max = Math.max(0.001, ...values.filter((v): v is number => v !== null), baseline ?? 0);
  const x = (i: number): number => (values.length <= 1 ? 0 : (i / (values.length - 1)) * width);
  const y = (v: number): number => height - (v / max) * height;

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden>
      {baseline !== undefined && (
        <line
          x1="0"
          x2={width}
          y1={y(baseline)}
          y2={y(baseline)}
          stroke="var(--color-rule)"
          strokeDasharray="2 3"
        />
      )}
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" />
      ))}
      {values.map((v, i) =>
        v === null ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === values.length - 1 ? 2.5 : 1.2} fill="var(--color-ink)" />
        ),
      )}
    </svg>
  );
}
