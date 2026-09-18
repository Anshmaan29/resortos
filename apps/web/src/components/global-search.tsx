'use client';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BedDouble, Car, ClipboardList, Search, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dialogIn, fade } from '@/lib/motion';
import type { SearchHit } from '@/lib/types';

const ICONS = { guest: UserRound, booking: ClipboardList, room: BedDouble, vehicle: Car } as const;
const GROUP_LABEL = { guest: 'Guests', booking: 'Bookings', room: 'Rooms', vehicle: 'Vehicles' } as const;

/**
 * Ctrl/Cmd + K (spec §71). One box for a guest, a mobile number, a room, a booking or a car —
 * whatever the desk happens to remember. Results are grouped and driven entirely from the keyboard.
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); return; }
      if (e.key === 'Escape') setOpen(false);
      // "/" is the other habit, but never while someone is typing in a field.
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setOpen(true); }
    };
    // The header button opens the same palette, so there is one search in the app, not two.
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resortos:search', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resortos:search', onOpen); };
  }, []);

  useEffect(() => {
    if (open) { setTerm(''); setActive(0); setTimeout(() => input.current?.focus(), 40); }
  }, [open]);

  const q = term.trim();
  const results = useQuery({
    queryKey: ['search', q],
    enabled: open && q.length >= 2,
    queryFn: () => api<SearchHit[]>('/search', { query: { q } }),
  });
  const hits = results.data ?? [];

  function go(hit: SearchHit | undefined) {
    if (!hit) return;
    setOpen(false);
    router.push(hit.href);
  }

  let rendered = -1;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          <motion.div {...fade} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <motion.div {...dialogIn} role="dialog" aria-modal="true" aria-label="Search"
            className="relative flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-surface shadow-lg">
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="h-5 w-5 shrink-0 text-text-3" aria-hidden />
              <input
                ref={input}
                id="global-search"
                value={term}
                onChange={(e) => { setTerm(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                  if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
                }}
                placeholder="Guest, mobile, room, booking or vehicle"
                className="h-14 w-full bg-transparent text-[15px] text-text outline-none placeholder:text-text-3"
                aria-label="Search everything"
                autoComplete="off"
              />
            </div>

            <div className="overflow-y-auto">
              {q.length < 2 && (
                <p className="px-4 py-6 text-sm text-text-3">Type at least two characters. Try a room number, part of a name, or a car.</p>
              )}
              {q.length >= 2 && results.isLoading && <p className="px-4 py-6 text-sm text-text-3">Searching…</p>}
              {q.length >= 2 && !results.isLoading && hits.length === 0 && (
                <p className="px-4 py-6 text-sm text-text-3">Nothing matches “{q}”.</p>
              )}

              {(['guest', 'booking', 'room', 'vehicle'] as const).map((kind) => {
                const group = hits.filter((h) => h.kind === kind);
                if (group.length === 0) return null;
                return (
                  <div key={kind}>
                    <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-3">{GROUP_LABEL[kind]}</p>
                    <ul>
                      {group.map((hit) => {
                        rendered += 1;
                        const index = rendered;
                        const Icon = ICONS[hit.kind];
                        return (
                          <li key={`${hit.kind}:${hit.id}`}>
                            <button
                              onClick={() => go(hit)}
                              onMouseEnter={() => setActive(index)}
                              className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left', active === index ? 'bg-surface-2' : '')}
                            >
                              <Icon className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{hit.title}</span>
                                <span className="block truncate text-xs text-text-3">{hit.subtitle}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>

            <p className="border-t border-border px-4 py-2 text-xs text-text-3">
              <kbd className="rounded border border-border px-1">↑</kbd> <kbd className="rounded border border-border px-1">↓</kbd> to move ·
              <kbd className="ml-1 rounded border border-border px-1">Enter</kbd> to open ·
              <kbd className="ml-1 rounded border border-border px-1">Esc</kbd> to close
            </p>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
