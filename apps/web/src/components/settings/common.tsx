'use client';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

/** A settings block: a card with a title, what it does, and an optional action. */
export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} action={action} />
      <div className="border-t border-border">{children}</div>
    </Card>
  );
}

/** A labelled on/off switch that is a real checkbox underneath (keyboard and screen reader friendly). */
export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-text-3">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={cn('h-6 w-11 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-surface-3')} />
        <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none', checked && 'translate-x-5')} />
        <span className="pointer-events-none absolute -inset-1 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-focus" />
      </span>
    </label>
  );
}

/**
 * Save something and refresh the lists that show it. Field errors from the server come back through
 * `fields`, so each form shows them inline beside the field they belong to.
 */
export function useSave<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, opts: { invalidate: QueryKey[]; success: string; onDone?: (r: TResult) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate) void qc.invalidateQueries({ queryKey: k });
      toast('success', opts.success);
      opts.onDone?.(r);
    },
  });
  return { ...m, fields: m.error instanceof ApiError ? m.error.fields : ({} as Record<string, string>) };
}

export function Row({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm last:border-0', muted && 'opacity-60')}>{children}</div>;
}
