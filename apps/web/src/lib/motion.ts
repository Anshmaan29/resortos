/** Motion presets (spec §69): 150–250 ms, ease-out, transform/opacity only. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15, ease: EASE_OUT } };
export const dialogIn = {
  initial: { opacity: 0, scale: 0.97, y: 8 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.98, y: 4 },
  transition: { duration: 0.2, ease: EASE_OUT },
};
export const drawerIn = { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' }, transition: { duration: 0.22, ease: EASE_OUT } };
export const stepIn = {
  initial: { opacity: 0, x: 16 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -16 }, transition: { duration: 0.2, ease: EASE_OUT },
};
