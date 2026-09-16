'use client';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { addDays, formatDate, formatDateInput, parseIndianDate } from '@resortos/shared';
import { cn } from '@/lib/cn';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Inserts slashes as the user types digits: "16092026" → "16/09/2026". */
function maskDigits(raw: string) {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('/');
}

function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export interface DateFieldProps {
  id?: string;
  value: string; // ISO yyyy-mm-dd or ''
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  today?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
  label?: string;
}

/**
 * Indian date entry (spec §68): always DD/MM/YYYY, independent of the browser's locale.
 * Type the digits or pick from the calendar. Dates outside min/max cannot be chosen.
 */
export function DateField({ id, value, onChange, min, max, today, invalid, label, ...aria }: DateFieldProps) {
  const [text, setText] = useState(value ? formatDateInput(value) : '');
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const initial = value || today || min || new Date().toISOString().slice(0, 10);
  const [view, setView] = useState({ year: Number(initial.slice(0, 4)), month: Number(initial.slice(5, 7)) - 1 });
  const [focusDay, setFocusDay] = useState(initial);
  const wrapper = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const popupId = useId();

  useEffect(() => {
    if (value && parseIndianDate(text) !== value) setText(formatDateInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrapper.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [open, focusDay, view]);

  const outOfRange = (iso: string) => (!!min && iso < min) || (!!max && iso > max);

  function commit(raw: string) {
    const iso = parseIndianDate(raw);
    if (!raw) { setProblem(null); onChange(''); return; }
    if (!iso) { setProblem('Enter the date as DD/MM/YYYY'); return; }
    if (outOfRange(iso)) { setProblem(min && iso < min ? `Choose ${formatDate(min)} or later` : `Choose ${formatDate(max!)} or earlier`); return; }
    setProblem(null);
    onChange(iso);
  }

  function pick(iso: string) {
    if (outOfRange(iso)) return;
    setText(formatDateInput(iso));
    setProblem(null);
    onChange(iso);
    setOpen(false);
  }

  function openCalendar() {
    const start = value || today || min || initial;
    setView({ year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) - 1 });
    setFocusDay(start);
    setOpen((o) => !o);
  }

  function moveFocus(days: number) {
    const next = addDays(focusDay, days);
    setFocusDay(next);
    setView({ year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) - 1 });
  }

  function onGridKey(e: KeyboardEvent) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -30, PageDown: 30 };
    if (e.key in moves) { e.preventDefault(); moveFocus(moves[e.key]!); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }

  const shiftMonth = (delta: number) => setView((v) => {
    const m = v.month + delta;
    return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
  });

  return (
    <div ref={wrapper} className="relative">
      <div className="relative">
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          placeholder="DD/MM/YYYY"
          value={text}
          aria-invalid={invalid || !!problem || undefined}
          aria-describedby={aria['aria-describedby']}
          onChange={(e) => {
            const masked = maskDigits(e.target.value);
            setText(masked);
            if (masked.length === 10) commit(masked);
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openCalendar(); } }}
          className="h-11 w-full rounded-md border border-border bg-surface pl-3 pr-11 text-[15px] text-text num placeholder:text-text-3 transition-colors hover:border-border-strong focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/25 aria-[invalid=true]:border-danger"
        />
        <button type="button" onClick={openCalendar} aria-label={`Choose ${label ?? 'date'} from calendar`} aria-expanded={open} aria-controls={popupId}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-text-2 hover:text-text">
          <CalendarDays className="h-[18px] w-[18px]" />
        </button>
      </div>
      {problem && <p className="mt-1 text-sm text-danger" role="alert">{problem}</p>}

      <AnimatePresence>
        {open && (
          <motion.div id={popupId} role="dialog" aria-label={`${label ?? 'Date'} calendar`}
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}
            className="absolute left-0 z-40 mt-2 w-[296px] rounded-lg border border-border bg-surface p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => shiftMonth(-1)} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-surface-2" aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
              <p className="text-sm font-semibold" aria-live="polite">{MONTHS[view.month]} {view.year}</p>
              <button type="button" onClick={() => shiftMonth(1)} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-surface-2" aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-7 text-center text-xs font-medium text-text-3">{WEEKDAYS.map((d) => <span key={d} className="py-1">{d}</span>)}</div>
            <div ref={grid} role="grid" onKeyDown={onGridKey} className="grid grid-cols-7 gap-0.5">
              {monthGrid(view.year, view.month).map((iso, i) => iso ? (
                <button key={iso} type="button" data-day={iso} tabIndex={iso === focusDay ? 0 : -1}
                  disabled={outOfRange(iso)} onClick={() => pick(iso)} aria-label={formatDate(iso, { weekday: true })} aria-pressed={iso === value}
                  className={cn('h-9 rounded-md text-sm num transition-colors disabled:cursor-not-allowed disabled:text-text-3 disabled:line-through disabled:opacity-60',
                    iso === value ? 'bg-brand font-semibold text-brand-contrast' : 'hover:bg-surface-2',
                    iso === today && iso !== value && 'ring-1 ring-inset ring-brand')}>
                  {Number(iso.slice(8))}
                </button>
              ) : <span key={`blank-${i}`} />)}
            </div>
            {today && !outOfRange(today) && (
              <button type="button" onClick={() => pick(today)} className="mt-2 w-full rounded-md py-2 text-sm font-medium text-brand hover:bg-brand-soft">Today · {formatDate(today)}</button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
