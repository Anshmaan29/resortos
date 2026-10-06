'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

interface Setup { roomTaxConfigured: boolean; foodTaxConfigured: boolean; cashConfigured: boolean; upiConfigured: boolean; rateFloorsConfigured: boolean; receptionistConfigured: boolean }
export function SetupReminder() {
  const me = useMe();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api<Setup>('/property/setup-status'), refetchInterval: 30_000 });
  if (status.isError) return <p role="alert">Hotel setup could not be checked. <button className="underline" onClick={() => { void status.refetch(); }}>Retry</button></p>;
  if (!status.data) return null;
  const s = status.data;
  const owner = me.data?.role === 'owner';
  const items = [
    !s.roomTaxConfigured && { text: 'Room GST rules are missing. Invoicing and checkout need accountant-confirmed rules.', tab: 'tax' },
    !s.foodTaxConfigured && { text: 'Add accountant-confirmed food GST rules before billing meals.', tab: 'tax' },
    !s.cashConfigured && { text: 'Cash payments need an active cash account.', tab: owner ? 'accounts' : null },
    !s.upiConfigured && { text: 'UPI payments need an active UPI account.', tab: owner ? 'accounts' : null },
    owner && !s.receptionistConfigured && { text: 'Create a separate receptionist account. Staff should use their own login.', tab: 'staff' },
  ].filter((i): i is { text: string; tab: string | null } => Boolean(i));
  if (!items.length) return null;
  return <section aria-label="Hotel setup" className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm">
    <h2 className="font-semibold text-warning">Finish hotel setup</h2>
    <ul className="mt-2 space-y-2">
      {items.map((i) => <li key={i.text}>{i.text} {i.tab ? <Link className="underline" href={`/settings?tab=${i.tab}`}>Open settings</Link> : 'Ask the owner to set it up.'}</li>)}
    </ul>
  </section>;
}
