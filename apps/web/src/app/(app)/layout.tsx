'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { Skeleton } from '@/components/ui/surface';
import { useMe, useProperty } from '@/lib/session';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const property = useProperty();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (me.isError) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [me.isError, router]);

  useEffect(()=>{
    if(property.data?.bookingModel!=='private_villa')return;
    const route:Record<string,string>={'/':'/villa','/reservations':'/villa/bookings','/reservations/new':'/villa/new','/in-house':'/villa/active','/calendar':'/villa/calendar','/rooms':'/villa/calendar','/check-in/express':'/villa/new'};
    const next=route[pathname]??(/^\/reservations\/[0-9a-f-]{36}$/.test(pathname)?pathname.replace('/reservations/','/villa/bookings/'):null);
    if(next)router.replace(next);
  },[property.data?.bookingModel,pathname,router]);

  if (!me.data) {
    return (
      <div className="flex min-h-dvh flex-col gap-4 p-6 lg:pl-66">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}
