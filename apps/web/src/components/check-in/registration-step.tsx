'use client';
import { formatDate, formatMobile } from '@resortos/shared';
import { CaptureSlot, SlotStatus } from '@/components/capture/capture-slot';
import { slotState } from '@/lib/capture/slot-state';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/surface';
import type { Property } from '@/lib/types';
import type { useDeskQueue } from './documents-step';
import { SignatureField } from './signature-field';
import type { CheckInDraft } from './types';

export function RegistrationStep({ draft, data, property, onChange, onRefresh, queue }: {
  draft: CheckInDraft; data: CheckInDraft['data']; property?: Property; onChange: (d: CheckInDraft['data']) => void; onRefresh: () => void; queue: ReturnType<typeof useDeskQueue>;
}) {
  const r = draft.reservation;
  const signatureDoc = [...draft.documents].reverse().find((d) => d.docType === 'signature');
  const item = queue.latest('signature');
  const state = slotState(signatureDoc?.status, item, item ? queue.progressOf(item.id) : 0);
  const setConsent = (key: 'stayAndCompliance' | 'marketing', value: boolean) => onChange({ ...data, consents: { ...data.consents, [key]: value } });

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
      <Card>
        <CardHeader title="Guest registration card" description="Read this with the guest before they sign." />
        <div className="flex flex-col gap-4 p-5 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div><dt className="text-text-2">Guest</dt><dd className="font-medium">{r.guestName}</dd></div>
            <div><dt className="text-text-2">Mobile</dt><dd className="font-medium num">{formatMobile(r.mobile)}</dd></div>
            <div><dt className="text-text-2">Stay</dt><dd className="font-medium num">{formatDate(r.arrival, { year: false })} → {formatDate(r.departure)}</dd></div>
            <div><dt className="text-text-2">Checkout time</dt><dd className="font-medium">{property ? to12h(property.checkOutTime) : '—'}</dd></div>
            <div className="col-span-2"><dt className="text-text-2">Booking</dt><dd className="font-medium num">{r.number}</dd></div>
          </dl>
          <div>
            <p className="mb-1 text-text-2">Guests</p>
            <ul className="list-disc pl-5">{data.rooms.flatMap((room) => room.occupants).map((o) => <li key={o.key}>{o.fullName || '—'}{o.isChild ? ` (child, ${o.age} yrs)` : ''}</li>)}</ul>
          </div>
          <div className="rounded-md bg-surface-2 p-3 text-text-2">
            <p className="font-medium text-text">House rules</p>
            <p>Valid ID is required for adult guests. Visitors must register at reception. The resort is not responsible for valuables left in the room.</p>
          </div>
          <div className="rounded-md bg-surface-2 p-3 text-text-2">
            <p className="font-medium text-text">Privacy notice · गोपनीयता सूचना</p>
            <p>We collect your details and ID to register your stay and meet legal requirements (including police and Form C reporting). Your ID images are kept securely and deleted after the legally required period.</p>
            <p lang="hi" className="mt-1">हम आपके ठहरने के पंजीकरण और कानूनी आवश्यकताओं के लिए आपका विवरण और पहचान पत्र लेते हैं। आपकी पहचान की तस्वीरें सुरक्षित रखी जाती हैं और निर्धारित अवधि के बाद हटा दी जाती हैं।</p>
          </div>
          <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--brand)]" checked={data.consents.stayAndCompliance} onChange={(e) => setConsent('stayAndCompliance', e.target.checked)} />
            <span>The guest agrees to the house rules and to the use of their details for the stay and legal compliance. <span className="text-danger">Required</span></span>
          </label>
          <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--brand)]" checked={data.consents.marketing} onChange={(e) => setConsent('marketing', e.target.checked)} />
            <span>The guest would like to receive offers from the resort. <span className="text-text-2">Optional</span></span>
          </label>
        </div>
      </Card>
      <Card className="xl:sticky xl:top-24 xl:self-start">
        <CardHeader title="Guest signature" description="Optional — draw it, take a photo, or upload a signature picture." action={<SlotStatus state={state} />} />
        <div className="space-y-5 p-5">
          <SignatureField disabled={state.kind === 'uploading' || state.kind === 'verifying'}
            onSigned={(png) => void queue.add({ slotKey: 'signature', docType: 'signature', source: 'signature_pad', blob: png, contentType: 'image/png' }).then(onRefresh)} />
          <CaptureSlot label="Signature photo" docType="signature" state={state} item={item} compact
            onDiscardFailed={() => { if (item && item.status !== 'done') void queue.remove(item.id); }}
            onCaptured={(result, via) => void queue.add({ slotKey: 'signature', docType: 'signature', source: via === 'file' ? 'file_upload' : 'desk_camera', blob: result.blob, thumbnail: result.thumbnail, contentType: 'image/jpeg' }).then(onRefresh)} />
          {item && item.status !== 'done' && <Button variant="outline" onClick={() => void queue.remove(item.id)}>Cancel signature upload</Button>}
          <p className="text-sm text-text-2">You can continue without a signature.</p>
        </div>
      </Card>
    </div>
  );
}

function to12h(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
