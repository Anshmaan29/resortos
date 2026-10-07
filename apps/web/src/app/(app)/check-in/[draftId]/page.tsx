'use client';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CloudCheck, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatDate } from '@resortos/shared';
import { ConfirmStep } from '@/components/check-in/confirm-step';
import { DocumentsStep } from '@/components/check-in/documents-step';
import { GuestsStep } from '@/components/check-in/guests-step';
import { RegistrationStep } from '@/components/check-in/registration-step';
import { RoomStep } from '@/components/check-in/room-step';
import { STEPS } from '@/components/check-in/types';
import { useCheckIn } from '@/components/check-in/use-check-in';
import { Button } from '@/components/ui/button';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { cn } from '@/lib/cn';
import { stepIn } from '@/lib/motion';
import { useProperty } from '@/lib/session';

/**
 * Desk check-in (spec §18). Every change is saved to the server-side draft, so a refresh,
 * crash or power cut resumes exactly here.
 */
export default function CheckInPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const property = useProperty();
  const c = useCheckIn(draftId, { pollDocuments: false });
  const { draft, reservation, queue, data, change, refresh, save, step, setStep, saveState, dirty, confirm, confirmed, uploading } = c;

  async function go(to: number) {
    if (!data) return;
    setStep(to);
    await save(data, to);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (draft.isError) return <ErrorBanner message={(draft.error as Error).message} onRetry={() => draft.refetch()} />;
  if (!draft.data || !data || !property.data) {
    if (draft.data && draft.data.status !== 'active') {
      return <ErrorBanner message={draft.data.status === 'confirmed' ? 'This check-in is already complete.' : 'This check-in was cancelled. Start it again from the booking.'} />;
    }
    return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-12" /><Skeleton className="h-96" /></div>;
  }
  const d = draft.data;

  return (
    <div className="flex flex-col gap-6 pb-24">
      <div>
        <Link href={`/reservations/${d.reservationId}`} className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ArrowLeft className="h-4 w-4" />{d.reservation.number}</Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Check in · {d.reservation.guestName}</h1>
            <p className="mt-1 text-sm text-text-2 num">{formatDate(d.reservation.arrival, { year: false })} → {formatDate(d.reservation.departure, { year: false })} · {d.reservation.rooms.length} room{d.reservation.rooms.length > 1 ? 's' : ''}</p>
          </div>
          <span className="flex items-center gap-1.5 text-sm text-text-2" role="status">
            {saveState === 'saving' ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
              : saveState === 'error' ? <span className="text-danger">Not saved — check the connection</span>
                : saveState === 'unsaved' ? 'Editing…' : <><CloudCheck className="h-4 w-4" />Saved</>}
          </span>
        </div>
      </div>

      {/* Progress */}
      <nav aria-label="Check-in steps">
        <ol className="grid grid-cols-5 gap-2">
          {STEPS.map((s) => (
            <li key={s.n}>
              <button onClick={() => go(s.n)} aria-current={step === s.n ? 'step' : undefined}
                className={cn('flex w-full flex-col gap-1.5 text-left')}>
                <span className="relative h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.span className="absolute inset-y-0 left-0 rounded-full bg-brand" initial={false} animate={{ width: step >= s.n ? '100%' : '0%' }} transition={{ duration: 0.25 }} />
                </span>
                <span className={cn('text-xs font-medium sm:text-sm', step === s.n ? 'text-brand' : 'text-text-2')}>
                  <span className="sm:hidden">{s.short}</span><span className="hidden sm:inline">{s.n}. {s.title}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <AnimatePresence mode="wait">
        <motion.div key={step} {...stepIn}>
          {step === 1 && <GuestsStep draft={d} data={data} onChange={change} />}
          {step === 2 && <RoomStep draft={d} data={data} businessDate={property.data.today} onChange={change} />}
          {step === 3 && <DocumentsStep draft={d} data={data} onChange={change} onRefresh={refresh} queue={queue} />}
          {step === 4 && <RegistrationStep draft={d} data={data} property={property.data} onChange={change} onRefresh={refresh} queue={queue} />}
          {step === 5 && <ConfirmStep draft={d} data={data} reservation={reservation.data} />}
        </motion.div>
      </AnimatePresence>

      {confirm.isError && <ErrorBanner message={(confirm.error as Error).message} />}

      {/* Sticky action bar */}
      <div className="no-print fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-60">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
          <Button variant="outline" onClick={() => go(Math.max(1, step - 1))} disabled={step === 1}><ArrowLeft className="h-4 w-4" />Back</Button>
          {uploading && <span className="hidden items-center gap-1.5 text-sm text-info sm:flex"><Loader2 className="h-4 w-4 animate-spin" />Uploading documents…</span>}
          {step < 5 ? (
            <Button onClick={() => go(step + 1)}>Next<ArrowRight className="h-4 w-4" /></Button>
          ) : (
            <Button size="lg" loading={confirm.isPending} disabled={uploading || d.problems.length > 0 || dirty.current || saveState === 'saving'}
              title={d.problems[0]?.message} onClick={() => confirm.mutate()}>
              <Check className="h-5 w-5" />Confirm check-in
            </Button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {confirmed && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="status">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }}
              className="flex flex-col items-center gap-3 rounded-xl bg-surface px-10 py-8 shadow-lg">
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 500, damping: 18 }}>
                <CheckCircle2 className="h-14 w-14 text-success" />
              </motion.span>
              <p className="text-lg font-semibold">Checked in</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
