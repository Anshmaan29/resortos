'use client';
import { Bed, Building, CreditCard, KeyRound, Mail, Monitor, Percent, Receipt, Settings2, Tags, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, type ComponentType } from 'react';
import { ChargeItemsSettings, PaymentAccountsSettings } from '@/components/settings/money';
import { DeskSettings, MyPinSettings } from '@/components/settings/desk';
import { MessageSettings } from '@/components/settings/messages';
import { PolicySettings, PropertySettings } from '@/components/settings/property';
import { RatesSettings } from '@/components/settings/rates';
import { RoomsSettings } from '@/components/settings/rooms';
import { StaffSettings } from '@/components/settings/staff';
import { TaxSettings } from '@/components/settings/tax';
import { PageHeader, Skeleton } from '@/components/ui/surface';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';

const SECTIONS: { key: string; label: string; icon: ComponentType<{ className?: string }>; owner: boolean; component: ComponentType }[] = [
  { key: 'property', label: 'Property', icon: Building, owner: true, component: PropertySettings },
  { key: 'policies', label: 'Policies & printing', icon: Settings2, owner: true, component: PolicySettings },
  { key: 'rooms', label: 'Rooms & room types', icon: Bed, owner: true, component: RoomsSettings },
  { key: 'rates', label: 'Room rates', icon: Tags, owner: true, component: RatesSettings },
  { key: 'tax', label: 'GST rules', icon: Percent, owner: false, component: TaxSettings },
  { key: 'staff', label: 'Staff & limits', icon: Users, owner: true, component: StaffSettings },
  { key: 'charges', label: 'Charge items', icon: Receipt, owner: true, component: ChargeItemsSettings },
  { key: 'accounts', label: 'Payment accounts', icon: CreditCard, owner: true, component: PaymentAccountsSettings },
  { key: 'messages', label: 'Guest messages', icon: Mail, owner: true, component: MessageSettings },
  { key: 'desks', label: 'Desk computers', icon: Monitor, owner: true, component: DeskSettings },
  { key: 'pin', label: 'My PIN', icon: KeyRound, owner: false, component: MyPinSettings },
];

function SettingsInner() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  if (!me.data) return <Skeleton className="h-96" />;
  const visible = SECTIONS.filter((s) => s.key === 'tax' ? ['owner', 'receptionist'].includes(me.data!.role) : !s.owner || me.data!.role === 'owner');
  const active = visible.find((s) => s.key === params.get('tab')) ?? visible[0]!;
  const Active = active.component;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description={me.data.role === 'owner' ? 'How the resort is set up. Every change is recorded in the audit log.' : me.data.role === 'receptionist' ? 'GST rules and your PIN. Every change is recorded in the audit log.' : 'Your PIN for switching in on a shared desk.'} />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto lg:flex-col">
          {visible.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.key} type="button" onClick={() => router.replace(`/settings?tab=${s.key}`)} aria-current={active.key === s.key ? 'page' : undefined}
                className={cn('flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm', active.key === s.key ? 'bg-brand-soft font-medium text-brand' : 'text-text-2 hover:bg-surface-2')}>
                <Icon className="h-4 w-4" />{s.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0"><Active /></div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><SettingsInner /></Suspense>;
}
