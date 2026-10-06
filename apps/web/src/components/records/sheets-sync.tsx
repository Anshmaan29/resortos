'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/surface';
import { api } from '@/lib/api';

interface Status { configured: boolean; serviceAccountEmail: string | null; lastAttemptAt: string | null; lastAttemptOk: boolean | null; message: string | null; url: string | null }
export function SheetsSync() {
  const status = useQuery({ queryKey: ['sheets-status'], queryFn: () => api<Status>('/sheets/status'), refetchInterval: 30_000 });
  const sync = useMutation({ mutationFn: () => api('/sheets/sync', { method: 'POST', body: {} }), onSettled: () => { void status.refetch(); } });
  return <Card>
    <CardHeader title="Google Sheets" description="A copy of bookings, guest names and masked mobiles, payments, invoices, expenses and daily summaries. Updates every five minutes when connected. Edit hotel records in ResortOS." />
    <div className="flex flex-col gap-3 p-4 text-sm">
      {status.isLoading ? <p>Checking connection…</p> : status.isError ? <p role="alert" className="text-danger">{(status.error as Error).message}</p> : !status.data?.configured
        ? <p>Not connected yet. Create a private hotel sheet; the connection can be set up when it is ready.</p>
        : <>
          <p>Connected · share the sheet with {status.data.serviceAccountEmail} as Editor.</p>
          <p>{status.data.lastAttemptAt ? `Last attempt: ${new Date(status.data.lastAttemptAt).toLocaleString('en-IN')}${status.data.lastAttemptOk ? ' · synced' : ' · needs attention'}` : 'First sync is waiting.'}</p>
          {status.data.message && <p role="alert" className="text-danger">{status.data.message}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>Sync now</Button>
            <a href={status.data.url!} target="_blank" rel="noopener noreferrer" className="underline">Open Google Sheet</a>
          </div>
        </>}
      {sync.isError && <p role="alert" className="text-danger">{(sync.error as Error).message}</p>}
      {sync.isSuccess && <p role="status" className="text-success">Sheet updated.</p>}
      <p className="text-text-3">Full phones, email, addresses, private notes, flags and ID details stay in ResortOS. Keep the sheet private. ResortOS tabs are replaced during sync; use separate tabs for your own notes.</p>
    </div>
  </Card>;
}
