'use client';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BedDouble, CalendarDays, ChevronDown, ClipboardList, Home, LogOut, Palmtree, Plus, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate } from '@resortos/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe, useProperty } from '@/lib/session';
import { Button } from './ui/button';

const NAV = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/reservations', label: 'Bookings', icon: ClipboardList },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/rooms', label: 'Rooms', icon: BedDouble },
];

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const property = useProperty();
  const online = useOnline();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (me.data?.mustChangePassword) router.replace('/change-password');
  }, [me.data, router]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Desktop shortcuts (spec §71): N new booking. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); router.push('/reservations/new'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Sidebar (desktop) */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-contrast"><Palmtree className="h-5 w-5" /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{property.data?.name ?? 'ResortOS'}</p>
            <p className="text-xs text-text-3">ResortOS</p>
          </div>
        </div>
        <div className="px-3 pb-3">
          <Link href="/reservations/new"><Button className="w-full justify-start" size="md"><Plus className="h-4 w-4" />New booking<kbd className="ml-auto rounded border border-white/30 px-1.5 text-[10px] font-normal opacity-80">N</kbd></Button></Link>
        </div>
        <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                className={cn('relative flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                  active ? 'text-brand' : 'text-text-2 hover:bg-surface-2 hover:text-text')}>
                {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-md bg-brand-soft" transition={{ duration: 0.2 }} />}
                <Icon className="relative h-[18px] w-[18px]" /><span className="relative">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Top bar */}
      <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur sm:px-6">
        <div className="flex items-center gap-2 lg:hidden">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-brand-contrast"><Palmtree className="h-4 w-4" /></div>
          <span className="max-w-[40vw] truncate text-sm font-semibold">{property.data?.name}</span>
        </div>
        {property.data && (
          <div className="hidden items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-sm sm:flex" title="Business date moves forward only at night audit">
            <span className="text-text-3">Business date</span>
            <span className="font-medium num">{formatDate(property.data.businessDate, { weekday: true })}</span>
          </div>
        )}
        {property.data?.isPractice && <span className="rounded-full bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">PRACTICE MODE</span>}
        <div className="ml-auto" ref={menuRef}>
          <button onClick={() => setMenu((m) => !m)} className="flex h-10 items-center gap-2 rounded-full pl-1 pr-3 hover:bg-surface-2" aria-haspopup="menu" aria-expanded={menu}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
              {me.data?.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-sm font-medium leading-tight">{me.data?.fullName}</span>
              <span className="block text-xs capitalize leading-tight text-text-3">{me.data?.role}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-text-3" />
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}
                role="menu" className="absolute right-4 mt-2 w-52 rounded-lg border border-border bg-surface p-1 shadow-lg sm:right-6">
                <Link href="/change-password" role="menuitem" className="flex h-10 items-center rounded-md px-3 text-sm hover:bg-surface-2">Change password</Link>
                <button onClick={logout} role="menuitem" className="flex h-10 w-full items-center gap-2 rounded-md px-3 text-sm text-danger hover:bg-danger-soft"><LogOut className="h-4 w-4" />Log out</button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      <AnimatePresence>
        {!online && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="status"
            className="sticky top-16 z-20 flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-white">
            <WifiOff className="h-4 w-4" />Offline — nothing new is saved until the internet is back.
          </motion.div>
        )}
      </AnimatePresence>

      <main className="mx-auto w-full max-w-[1400px] px-4 pb-28 pt-6 sm:px-6 lg:pb-10">{children}</main>

      {/* Bottom nav (phones/tablets) */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="Main">
        {NAV.slice(0, 2).map((item) => <MobileNavItem key={item.href} {...item} active={isActive(item.href)} />)}
        <Link href="/reservations/new" className="flex flex-col items-center justify-center" aria-label="New booking">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-brand-contrast shadow-md"><Plus className="h-5 w-5" /></span>
        </Link>
        {NAV.slice(2).map((item) => <MobileNavItem key={item.href} {...item} active={isActive(item.href)} />)}
      </nav>
    </div>
  );
}

function MobileNavItem({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof Home; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={cn('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-brand' : 'text-text-3')}>
      <Icon className="h-5 w-5" />{label}
    </Link>
  );
}
