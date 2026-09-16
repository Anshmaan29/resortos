'use client';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { Skeleton } from '@/components/ui/surface';
import { useMe } from '@/lib/session';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();

  useEffect(() => {
    if (me.isError) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [me.isError, router]);

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
