import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG 2.2 AA (spec §73): normal-size text needs 4.5:1 against every surface it is used on. */
const css = readFileSync(join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf('@theme inline'))) };

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
const TEXT_ON_SURFACES = ['text', 'text-2', 'text-3', 'brand', 'danger', 'warning', 'success', 'info'];
const PAIRS: [string, string][] = [
  ['brand', 'brand-soft'], ['danger', 'danger-soft'], ['warning', 'warning-soft'], ['success', 'success-soft'], ['info', 'info-soft'],
  ['brand-contrast', 'brand'],
  ['st-ready', 'st-ready-bg'], ['st-occupied', 'st-occupied-bg'], ['st-dirty', 'st-dirty-bg'], ['st-cleaning', 'st-cleaning-bg'],
  ['st-arriving', 'st-arriving-bg'], ['st-due-out', 'st-due-out-bg'], ['st-maint', 'st-maint-bg'], ['st-ooo', 'st-ooo-bg'],
];

describe.each([['light', light], ['dark', dark]] as const)('%s theme meets WCAG AA', (_, t) => {
  it.each(TEXT_ON_SURFACES.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as [string, string])))('%s on %s', (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(PAIRS)('%s on %s', (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
