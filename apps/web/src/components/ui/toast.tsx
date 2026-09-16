'use client';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { EASE_OUT } from '@/lib/motion';

interface Toast { id: number; tone: 'success' | 'error'; message: string }
const ToastCtx = createContext<(tone: Toast['tone'], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className="pointer-events-auto flex max-w-md items-center gap-2 rounded-lg bg-text px-4 py-3 text-sm text-bg shadow-lg">
              {t.tone === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--st-ready-bg)]" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--st-dirty-bg)]" />}
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
