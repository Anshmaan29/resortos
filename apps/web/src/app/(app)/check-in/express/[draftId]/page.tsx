'use client';
import { AnimatePresence, motion } from 'motion/react';
import { Check, CheckCircle2, CloudCheck, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { formatDate } from '@resortos/shared';
import { ConfirmStep } from '@/components/check-in/confirm-step';
import { DocumentsStep } from '@/components/check-in/documents-step';
import { GuestsStep } from '@/components/check-in/guests-step';
import { RegistrationStep } from '@/components/check-in/registration-step';
import { RoomStep } from '@/components/check-in/room-step';
import { useCheckIn } from '@/components/check-in/use-check-in';
import { Button } from '@/components/ui/button';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { useProperty } from '@/lib/session';

/**
 * The rest of an express check-in, on one page: guests, room, IDs, registration card and signature,
 * and confirm — the same draft, autosave and confirm as the step-by-step wizard (`useCheckIn`).
 */
export default function ExpressDraftPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const property = useProperty();
  const { draft, reservation, queue, data, change, refresh, saveState, dirty, confirm, confirmed, uploading } =
    useCheckIn(draftId, { pollDocuments: true, initialStep: () => 5, afterConfirm: 'stay' });

  if (draft.isError) return <ErrorBanner message={(draft.error as Error).message} onRetry={() => draft.refetch()} />;
  if (!draft.data || !data || !property.data) {
    if (draft.data && draft.data.status !== 'active') return <ErrorBanner message={draft.data.status === 'confirmed' ? 'This check-in is already complete.' : 'This check-in was cancelled.'} />;
    return <Skeleton className="h-96" />;
  }
  const d = draft.data;
  const sections = [
    { title: 'Guests', body: <GuestsStep draft={d} data={data} onChange={change} /> },
    { title: 'Room', body: <RoomStep draft={d} data={data} businessDate={property.data.today} onChange={change} /> },
    { title: 'IDs', body: <DocumentsStep draft={d} data={data} onChange={change} onRefresh={refresh} queue={queue} /> },
    { title: 'Registration card and signature', body: <RegistrationStep draft={d} data={data} property={property.data} onChange={change} onRefresh={refresh} queue={queue} /> },
    { title: 'Check', body: <ConfirmStep draft={d} data={data} reservation={reservation.data} /> },
  ];
  return (
    <div className="flex flex-col gap-8 pb-28">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Express check-in · {d.reservation.guestName}</h1>
          <p className="mt-1 text-sm text-text-2">{d.reservation.number} · {formatDate(d.reservation.arrival, { year: false })} → {formatDate(d.reservation.departure, { year: false })}</p>
        </div>
        <span className="flex items-center gap-1.5 text-sm text-text-2" role="status">
          {saveState === 'saving' ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
            : saveState === 'error' ? <span className="text-danger">Not saved — check the connection</span>
              : saveState === 'unsaved' ? 'Editing…' : <><CloudCheck className="h-4 w-4" />Saved</>}
        </span>
      </div>
      {sections.map((s, i) => (
        <section key={s.title} aria-labelledby={`express-${i}`}>
          <h2 id={`express-${i}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-3">{i + 1}. {s.title}</h2>
          {s.body}
        </section>
      ))}
      {confirm.isError && <ErrorBanner message={(confirm.error as Error).message} />}
      <div className="no-print fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-60">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
          <p className="text-sm text-text-2">{d.problems.length ? d.problems[0]!.message.charAt(0).toUpperCase() + d.problems[0]!.message.slice(1) : uploading ? 'Uploading documents…' : 'Everything needed is here.'}</p>
          <Button size="lg" loading={confirm.isPending} disabled={uploading || d.problems.length > 0 || dirty.current || saveState === 'saving'} onClick={() => confirm.mutate()}>
            <Check className="h-5 w-5" />Confirm check-in
          </Button>
        </div>
      </div>
      <AnimatePresence>
        {confirmed && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="status">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.2 }} className="flex flex-col items-center gap-3 rounded-xl bg-surface px-10 py-8 shadow-lg">
              <CheckCircle2 className="h-14 w-14 text-success" />
              <p className="text-lg font-semibold">Checked in</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
