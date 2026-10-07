'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookUser } from 'lucide-react';
import { useState } from 'react';
import { FORM_C_REQUIRED, formatDate, formCDetailsSchema, type FormCDetailsInput } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import { useMe } from '@/lib/session';

/**
 * Form C (spec §58.1): the desk fills in what the official portal asks for and marks the record
 * submitted with the reference it gives back. The record itself is opened by the database the
 * moment a foreign guest is checked in, so every row here is real work waiting.
 */

interface FormCRecord {
  id: string;
  status: 'pending' | 'submitted' | 'departure_updated';
  stayId: string;
  guestName: string;
  nationality: string;
  roomNumber: string;
  arrivedAt: string;
  expectedDeparture: string;
  departedOn: string | null;
  hoursLeft: number | null;
  version: number;
  details: Record<string, string | null>;
  submittedReference: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  missing: string[];
  documents?: { id: string; docType: string }[];
}

const FIELD_LABELS: Record<string, string> = {
  passportNumber: 'Passport number', passportPlaceOfIssue: 'Passport place of issue', passportIssueDate: 'Passport issue date',
  passportExpiryDate: 'Passport expiry date', visaNumber: 'Visa number', visaType: 'Visa type', visaPlaceOfIssue: 'Visa place of issue',
  visaIssueDate: 'Visa issue date', visaExpiryDate: 'Visa expiry date', arrivalInIndiaDate: 'Date arrived in India',
  arrivalPort: 'Port of arrival', nextDestination: 'Next destination', addressInIndia: 'Address in India',
  contactInIndia: 'Contact in India', homeAddress: 'Address at home', homeContact: 'Contact at home',
};
const DATE_FIELDS = new Set(['passportIssueDate', 'passportExpiryDate', 'visaIssueDate', 'visaExpiryDate', 'arrivalInIndiaDate']);
const TEXTAREA_FIELDS = new Set(['addressInIndia', 'homeAddress']);

const STATUS_LABEL: Record<FormCRecord['status'], string> = { pending: 'Pending', submitted: 'Submitted', departure_updated: 'Departure updated' };

export default function FormCPage() {
  const me = useMe();
  const list = useQuery({ queryKey: ['form-c'], queryFn: () => api<FormCRecord[]>('/form-c') });
  const pending = useQuery({ queryKey: ['form-c-pending'], queryFn: () => api<{ pending: number; hoursLeft: number | null }>('/form-c/pending-summary') });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['form-c', selectedId],
    enabled: !!selectedId,
    queryFn: () => api<FormCRecord & { documents: { id: string; docType: string }[] }>(`/form-c/${selectedId}`),
  });

  const groups: Record<FormCRecord['status'], FormCRecord[]> = { pending: [], submitted: [], departure_updated: [] };
  for (const r of list.data ?? []) groups[r.status].push(r);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Form C"
        description="Foreign guests must be reported within 24 hours of arrival. The record opens by itself at check-in; you fill it in, copy it to the portal, and keep the reference."
        actions={pending.data?.pending ? (
          <Pill tone={pending.data.hoursLeft !== null && pending.data.hoursLeft < 6 ? 'danger' : 'warning'}>
            {pending.data.pending} pending{pending.data.hoursLeft !== null ? ` · ${pending.data.hoursLeft}h left` : ''}
          </Pill>
        ) : undefined}
      />

      {list.isLoading ? <Skeleton className="h-40" /> : list.isError ? (
        <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : (list.data ?? []).length === 0 ? (
        <Card><EmptyState icon={<BookUser className="h-5 w-5" />} title="No Form C records" description="One appears here automatically when a foreign national checks in." /></Card>
      ) : (
        (['pending', 'submitted', 'departure_updated'] as const).map((status) => groups[status].length > 0 && (
          <Card key={status}>
            <CardHeader title={STATUS_LABEL[status]} description={status === 'pending' ? 'Fill in the details, then copy the summary into the official portal.' : undefined} />
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-sm">
                <thead className="text-left text-text-3">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-4 py-2 font-medium">Guest</th>
                    <th scope="col" className="px-4 py-2 font-medium">Nationality</th>
                    <th scope="col" className="px-4 py-2 font-medium">Room</th>
                    <th scope="col" className="px-4 py-2 font-medium">Arrived</th>
                    {status === 'pending' && <th scope="col" className="px-4 py-2 font-medium">Time left</th>}
                    {status !== 'pending' && <th scope="col" className="px-4 py-2 font-medium">Portal reference</th>}
                    <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {groups[status].map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2 font-medium">{r.guestName}</td>
                      <td className="px-4 py-2">{r.nationality}</td>
                      <td className="px-4 py-2">{r.roomNumber}</td>
                      <td className="px-4 py-2">{formatDate(r.arrivedAt.slice(0, 10))}</td>
                      {status === 'pending' && (
                        <td className="px-4 py-2">
                          <Pill tone={r.hoursLeft !== null && r.hoursLeft < 6 ? 'danger' : r.hoursLeft !== null && r.hoursLeft < 18 ? 'warning' : 'neutral'}>
                            {r.hoursLeft !== null && r.hoursLeft >= 0 ? `${r.hoursLeft}h left` : `${Math.abs(r.hoursLeft ?? 0)}h late`}
                          </Pill>
                        </td>
                      )}
                      {status !== 'pending' && <td className="px-4 py-2 tabular-nums">{r.submittedReference}</td>}
                      <td className="px-4 py-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedId(r.id)}>Open</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      {selectedId && (detail.isLoading || detail.isError ? (
        <Dialog open onClose={() => setSelectedId(null)} title="Form C" size="lg">
          {detail.isError
            ? <ErrorBanner message={(detail.error as Error).message} onRetry={() => detail.refetch()} />
            : <Skeleton className="h-96" />}
        </Dialog>
      ) : (
        <FormCDetail
          id={selectedId}
          detail={detail.data!}
          onClose={() => { setSelectedId(null); void list.refetch(); void pending.refetch(); }}
        />
      ))}
    </div>
  );
}

function FormCDetail({ id, detail, onClose }: { id: string; detail: FormCRecord & { documents: { id: string; docType: string }[] }; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(detail?.details ?? {}).map(([k, v]) => [k, v ?? ''])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [portal, setPortal] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [submitOpen, setSubmitOpen] = useState(false);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: (input: FormCDetailsInput) => api<FormCRecord>(`/form-c/${id}`, { method: 'PUT', body: input }),
    onSuccess: (saved) => {
      toast('success', 'Details saved');
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['form-c'] });
      if (saved.status === 'pending') setForm((f) => ({ ...f }));
    },
    onError: (err) => toast('error', (err as Error).message),
  });

  const submit = useMutation({
    mutationFn: () => api<FormCRecord>(`/form-c/${id}/submit`, { method: 'POST', body: { reference, version: detail?.version } }),
    onSuccess: () => {
      toast('success', 'Form C marked submitted');
      setSubmitOpen(false);
      void qc.invalidateQueries({ queryKey: ['form-c'] });
      onClose();
    },
    onError: (err) => toast('error', (err as Error).message),
  });

  const departure = useMutation({
    mutationFn: () => api<FormCRecord>(`/form-c/${id}/departure-updated`, { method: 'POST', body: { version: detail?.version } }),
    onSuccess: () => { toast('success', 'Departure recorded as updated'); void qc.invalidateQueries({ queryKey: ['form-c'] }); onClose(); },
    onError: (err) => toast('error', (err as Error).message),
  });

  const portalSummary = useMutation({
    mutationFn: () => api<{ text: string; missing: string[] }>(`/form-c/${id}/portal-summary`),
    onSuccess: (p) => { setPortal(p.text); void navigator.clipboard?.writeText(p.text).catch(() => undefined); toast('success', 'Summary copied — paste it into the portal'); },
    onError: (err) => toast('error', (err as Error).message),
  });

  const openDocument = async (documentId: string) => {
    try {
      const { url } = await api<{ url: string }>(`/documents/${documentId}/view-url`);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const saveAll = () => {
    if (!detail) return;
    const candidate = {
      ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? undefined : v])),
      version: detail.version,
    };
    const parsed = formCDetailsSchema.safeParse(candidate);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
      setErrors(fieldErrors);
      return;
    }
    save.mutate(parsed.data);
  };

  const isPending = detail.status === 'pending';

  return (
    <>
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`${detail.guestName} · ${detail.nationality} · Room ${detail.roomNumber}`}
      description={`${STATUS_LABEL[detail.status]}${detail.submittedReference ? ` · Portal reference ${detail.submittedReference}` : ''} · arrived ${formatDate(detail.arrivedAt.slice(0, 10))}`}
      footer={
        isPending ? (
          <>
            <Button variant="ghost" onClick={() => portalSummary.mutate()} disabled={portalSummary.isPending}>Copy portal summary</Button>
            <Button onClick={() => { setReference(''); setSubmitOpen(true); }} disabled={detail.missing.length > 0}
              title={detail.missing.length ? 'Fill in every field the portal asks for first' : undefined}>
              Mark submitted
            </Button>
          </>
        ) : detail.status === 'submitted' ? (
          <Button variant="ghost" onClick={() => departure.mutate()} disabled={departure.isPending}>Departure updated on the portal</Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {detail.missing.length > 0 && isPending && (
          <ErrorBanner
            message={`Still needed for the portal: ${detail.missing.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.`}
          />
        )}

        {detail.documents && detail.documents.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {detail.documents.map((d) => (
              <Button key={d.id} variant="ghost" size="sm" onClick={() => openDocument(d.id)}>
                View {d.docType.replace(/_/g, ' ')} (60-second link)
              </Button>
            ))}
          </div>
        )}

        {portal && (
          <Card>
            <CardHeader title="Ready to paste into the portal" />
            <pre className="overflow-x-auto whitespace-pre-wrap px-4 pb-4 text-sm">{portal}</pre>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Object.keys(FIELD_LABELS).map((key) => (
            <Field key={key} label={FIELD_LABELS[key]!} error={errors[key]} required={(FORM_C_REQUIRED as readonly string[]).includes(key)} className={TEXTAREA_FIELDS.has(key) ? 'sm:col-span-2' : undefined}>
              {(inputId) => DATE_FIELDS.has(key) ? (
                <Input id={inputId} type="date" value={form[key] ?? ''} onChange={set(key)} invalid={!!errors[key]} disabled={!isPending} />
              ) : TEXTAREA_FIELDS.has(key) ? (
                <Textarea id={inputId} value={form[key] ?? ''} onChange={set(key)} aria-invalid={!!errors[key] || undefined} disabled={!isPending} />
              ) : (
                <Input id={inputId} value={form[key] ?? ''} onChange={set(key)} invalid={!!errors[key]} disabled={!isPending} className={key === 'passportNumber' || key === 'visaNumber' ? 'uppercase' : undefined} />
              )}
            </Field>
          ))}
        </div>

        {isPending && <Button onClick={saveAll} disabled={save.isPending} className="self-start">Save details</Button>}
      </div>
    </Dialog>

      <Dialog open={submitOpen} onClose={() => setSubmitOpen(false)} title="Mark submitted on the portal" size="sm"
        description="After you have filed it on the official portal, enter the reference number it gave you."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSubmitOpen(false)}>Cancel</Button>
            <Button onClick={() => submit.mutate()} disabled={submit.isPending || reference.trim().length < 3}>Save reference</Button>
          </>
        }>
        <Field label="Portal reference number" required hint="Example: UKFR012345">
          {(inputId) => <Input id={inputId} value={reference} onChange={(e) => setReference(e.target.value)} className="uppercase" autoFocus />}
        </Field>
      </Dialog>
    </>
  );
}
