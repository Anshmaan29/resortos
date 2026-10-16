'use client';
import { useQuery, useIsMutating } from '@tanstack/react-query';
import { Palmtree } from 'lucide-react';
import { api, PROPERTY_CONTEXT_KEY } from '@/lib/api';
import { useMe, useProperty } from '@/lib/session';
export function PropertySelector() {
  const me = useMe();
  const property = useProperty();
  const busy = useIsMutating();
  const properties = useQuery({
    queryKey: ['accessible-properties'],
    queryFn: () => api<{ id: string; name: string; bookingModel: string }[]>('/auth/properties'),
    enabled: me.data?.role === 'owner',
  });
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-contrast">
        <Palmtree className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        {me.data?.role === 'owner' && (properties.data?.length ?? 0) > 1 ? (
          <select
            aria-label="Choose resort"
            disabled={busy > 0}
            value={property.data?.id ?? ''}
            className="w-full cursor-pointer truncate rounded-md border border-border bg-surface py-2 text-sm font-semibold"
            onChange={(event) => {
              if (
                document.querySelector('form') &&
                !window.confirm('Switch resorts? Any unsaved changes on this screen will be discarded.')
              ) {
                event.target.value = property.data?.id ?? '';
                return;
              }
              const target = properties.data?.find((p) => p.id === event.target.value);
              if (!target) return;
              window.sessionStorage.setItem(PROPERTY_CONTEXT_KEY, target.id);
              // Full navigation drops forms, caches and pending reads together. Other tabs retain their own context.
              window.location.assign(target.bookingModel === 'private_villa' ? '/villa' : '/');
            }}
          >
            {properties.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="truncate text-sm font-semibold leading-tight">{property.data?.name ?? 'ResortOS'}</p>
        )}
        <p className="text-xs text-text-3">ResortOS</p>
      </div>
    </div>
  );
}
