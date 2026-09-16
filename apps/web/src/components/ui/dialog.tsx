'use client';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { dialogIn, drawerIn, fade } from '@/lib/motion';

function useModalBehaviour(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, button, select')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      clearTimeout(t);
      previous?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useModalBehaviour(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <motion.div {...fade} className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
          <motion.div
            {...dialogIn}
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn('relative flex max-h-[92vh] w-full flex-col rounded-t-xl bg-surface shadow-lg sm:rounded-xl',
              size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md')}
          >
            <div className="flex items-start justify-between gap-4 px-5 pt-5">
              <div>
                <h2 className="text-lg font-semibold text-text">{title}</h2>
                {description && <p className="mt-1 text-sm text-text-3">{description}</p>}
              </div>
              <button onClick={onClose} className="-m-2 rounded-md p-2 text-text-3 hover:bg-surface-2 hover:text-text" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useModalBehaviour(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div {...fade} className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
          <motion.aside {...drawerIn} ref={ref} role="dialog" aria-modal="true"
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-surface shadow-lg">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0 text-lg font-semibold">{title}</div>
              <button onClick={onClose} className="-m-2 rounded-md p-2 text-text-3 hover:bg-surface-2" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
