'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BedDouble, DoorOpen, Building2, Lock, BookUser, CalendarDays, ChevronDown, ClipboardCheck, ClipboardList, FileText, Globe, Home, Landmark, LogOut, Menu, MoonStar, Palmtree, Plus, Search, Settings, Sparkles, SprayCan, UserRound, Wallet, Wrench, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate } from '@resortos/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe, useProperty } from '@/lib/session';
import { GlobalSearch } from './global-search';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const NAV = [
  { href: '/', label: 'Home', icon: Home, phone: true },
  { href: '/reservations', label: 'Bookings', icon: ClipboardList, phone: true },
  { href: '/guests', label: 'Guests', icon: UserRound, phone: true },
  { href: '/in-house', label: 'In house', icon: BedDouble, phone: true },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, phone: false },
  { href: '/rooms', label: 'Rooms', icon: DoorOpen, phone: false },
  { href: '/housekeeping', label: 'Housekeeping', icon: SprayCan, phone: false },
  { href: '/form-c', label: 'Form C', icon: BookUser, phone: false },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench, phone: false },
  { href: '/shifts', label: 'Shift', icon: Wallet, phone: false },
  { href: '/night-audit', label: 'Night audit', icon: MoonStar, phone: false },
  { href: '/review', label: 'To review', icon: ClipboardCheck, phone: false, owner: true },
  { href: '/accounts', label: 'Accounts', icon: Landmark, phone: false, owner: true },
  { href: '/invoices', label: 'Invoices', icon: FileText, phone: false, owner: true },
  { href: '/companies', label: 'Companies', icon: Building2, phone: false, owner: true },
  { href: '/ota', label: 'OTA payouts', icon: Globe, phone: false, owner: true },
  { href: '/expenses', label: 'Expenses', icon: Wallet, phone: false, owner: true },
  { href: '/records', label: 'Records', icon: Sparkles, phone: false, owner: true },
  { href: '/settings', label: 'Settings', icon: Settings, phone: false },
];

/** Four fit around the new-booking button; the rest live in the sidebar on bigger screens. */
const PHONE_NAV = NAV.filter((n) => n.phone);

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
  const [navigationOpen, setNavigationOpen] = useState(false);
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
      if (me.data?.role !== 'cleaner' && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); router.push('/reservations/new'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, me.data?.role]);

  // Shared desk (spec §5.3): lock after the owner's idle time, or on demand. Locking ends the session;
  // the lock screen switches people in by PIN.
  const desk = useQuery({ queryKey: ['desk'], queryFn: () => api<{ trusted: boolean; lockMinutes?: number }>('/desk'), staleTime: 300_000 });
  const lockDesk = useCallback(async () => {
    await api('/desk/lock', { method: 'POST', body: {} }).catch(() => undefined);
    qc.clear();
    router.replace('/desk');
  }, [qc, router]);
  useEffect(() => {
    if (!desk.data?.trusted || !desk.data.lockMinutes) return;
    let timer = setTimeout(lockDesk, desk.data.lockMinutes * 60_000);
    const reset = () => { clearTimeout(timer); timer = setTimeout(lockDesk, desk.data!.lockMinutes! * 60_000); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => { clearTimeout(timer); for (const e of events) window.removeEventListener(e, reset); };
  }, [desk.data, lockDesk]);

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const visibleNav = NAV.filter((item) => me.data?.role === 'cleaner' ? item.href === '/housekeeping' : !('owner' in item) || me.data?.role === 'owner');

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
        {me.data?.role !== 'cleaner' && <div className="px-3 pb-3">
          <Link href="/reservations/new"><Button className="w-full justify-start" size="md"><Plus className="h-4 w-4" />New booking<kbd className="ml-auto rounded border border-white/30 px-1.5 text-[10px] font-normal opacity-80">N</kbd></Button></Link>
        </div>}
        <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-3 pb-4" aria-label="Main">
          {visibleNav.map((item) => {
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
        <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 lg:hidden" aria-label="Open navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><Menu className="h-5 w-5" aria-hidden /></button>
        <div className="flex items-center gap-2 lg:hidden">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-brand-contrast"><Palmtree className="h-4 w-4" /></div>
          <span className="max-w-[40vw] truncate text-sm font-semibold">{property.data?.name}</span>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('resortos:search'))}
          className="ml-auto flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-text-3 hover:bg-surface-2 hover:text-text-2 sm:ml-0"
          aria-label="Open search"
        >
          <Search className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border px-1 text-[10px] lg:inline">Ctrl K</kbd>
        </button>
        {property.data && (
          <div className="hidden items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-sm sm:flex" title="Current date in the hotel’s timezone">
            <span className="text-text-3">Today</span>
            <span className="font-medium num">{formatDate(property.data.today, { weekday: true })}</span>
          </div>
        )}
        {property.data && property.data.businessDate !== property.data.today && (
          <Link href="/night-audit" className="hidden text-xs text-text-3 lg:block" title="Night audit closes this accounting date">
            Day closing: {formatDate(property.data.businessDate, { year: false })}
          </Link>
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
                {desk.data?.trusted && (
                  <button onClick={lockDesk} role="menuitem" className="flex h-10 w-full items-center gap-2 rounded-md px-3 text-sm hover:bg-surface-2"><Lock className="h-4 w-4" />Lock desk</button>
                )}
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

      <GlobalSearch />

      <main className="mx-auto min-w-0 w-full max-w-[1400px] px-4 pb-28 pt-6 sm:px-6 lg:pb-10">{children}</main>
      <Dialog open={navigationOpen} onClose={() => setNavigationOpen(false)} title="Menu">
        <nav aria-label="All pages" className="grid grid-cols-2 gap-1">
          {visibleNav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setNavigationOpen(false)} aria-current={isActive(href) ? 'page' : undefined} className={cn('flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium', isActive(href) ? 'bg-brand-soft text-brand' : 'hover:bg-surface-2')}><Icon className="h-5 w-5" aria-hidden />{label}</Link>)}
        </nav>
      </Dialog>

      {/* Bottom nav (phones/tablets) */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="Main">
        {(me.data?.role === 'cleaner' ? visibleNav : PHONE_NAV.slice(0, 2)).map((item) => <MobileNavItem key={item.href} {...item} active={isActive(item.href)} />)}
        {me.data?.role !== 'cleaner' && <Link href="/reservations/new" className="flex flex-col items-center justify-center" aria-label="New booking">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-brand-contrast shadow-md"><Plus className="h-5 w-5" /></span>
        </Link>}
        {me.data?.role !== 'cleaner' && PHONE_NAV.slice(2).map((item) => <MobileNavItem key={item.href} {...item} active={isActive(item.href)} />)}
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
