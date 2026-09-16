'use client';
import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

/** Counts up once on first load, ≤ 500 ms (spec §69.1). */
export function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (done.current || reduce) { el.textContent = String(value); return; }
    done.current = true;
    const controls = animate(0, value, { duration: 0.45, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => { el.textContent = String(Math.round(v)); } });
    return () => controls.stop();
  }, [value, reduce]);
  return <span ref={ref} className="num">{value}</span>;
}
