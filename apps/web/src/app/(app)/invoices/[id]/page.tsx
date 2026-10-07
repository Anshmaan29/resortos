'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { formatDate, formatINR, money } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Card, CardHeader, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, apiUrl, newIdempotencyKey } from '@/lib/api';
import { useMe } from '@/lib/session';
import type { Invoice } from '@/lib/types';

const TITLE = { tax_invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', credit_note: 'Credit note', debit_note: 'Debit note' } as const;

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const [crediting, setCrediting] = useState(false);
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api<Invoice>(`/invoices/${id}`) });

  if (invoice.isLoading) return <Skeleton className="h-96" />;
  if (invoice.isError) return <ErrorBanner message={(invoice.error as Error).message} onRetry={() => invoice.refetch()} />;
  const i = invoice.data!;
  const canCredit = me.data?.role === 'owner' && i.documentType !== 'credit_note';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${TITLE[i.documentType]} ${i.number}`}
        description={`${formatDate(i.invoiceDate)} · issued by ${i.finalizedBy}${i.original ? ` · against ${i.original.number}` : ''}`}
        actions={<>
          {canCredit && <Button variant="outline" onClick={() => setCrediting(true)}>Credit note</Button>}
          <Button onClick={() => window.open(apiUrl(`/invoices/${i.id}/pdf`), '_blank')}><Printer className="h-4 w-4" aria-hidden />Print</Button>
        </>}
      />
      {i.reason && <p className="text-sm"><span className="text-text-3">Reason:</span> {i.reason}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4 text-sm">
          <p className="text-xs uppercase tracking-wide text-text-3">Billed to</p>
          <p className="mt-1 font-medium">{i.buyer.name}</p>
          {i.buyer.gstin && <p>GSTIN {i.buyer.gstin}</p>}
          {i.buyer.address && <p className="text-text-2">{i.buyer.address}</p>}
        </Card>
        <Card className="p-4 text-sm">
          <p className="text-xs uppercase tracking-wide text-text-3">Stay</p>
          {i.stay.from && i.stay.to && <p className="mt-1">{formatDate(i.stay.from)} to {formatDate(i.stay.to)}</p>}
          {i.stay.rooms && <p>Room {i.stay.rooms}</p>}
          {i.stay.reservationNumber && <p className="text-text-2">Booking {i.stay.reservationNumber}</p>}
        </Card>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-text-3">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">Date</th>
                <th scope="col" className="px-4 py-2 font-medium">Description</th>
                <th scope="col" className="px-4 py-2 font-medium">SAC</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Discount</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Taxable</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">GST</th>
              </tr>
            </thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(l.businessDate, { year: false })}</td>
                  <td className="px-4 py-2">{l.description}{Number(l.quantity) !== 1 && <span className="ml-1 text-text-3">× {Number(l.quantity)}</span>}</td>
                  <td className="px-4 py-2 tabular-nums text-text-2">{l.sac}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(l.discount) ? formatINR(l.discount) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(l.taxable)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(l.gstRate)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="flex flex-col gap-1 border-t border-border p-4 text-sm">
          {i.groups.filter((g) => Number(g.ratePercent) > 0).map((g) => (
            <div key={g.ratePercent} className="flex justify-between"><dt className="text-text-2">{Number(g.igst) ? 'IGST' : 'CGST + SGST'} at {Number(g.ratePercent)}% on {formatINR(g.taxableValue)}</dt><dd className="tabular-nums">{formatINR(money(g.cgst).plus(g.sgst).plus(g.igst).toFixed(2))}</dd></div>
          ))}
          {Number(i.roundOff) !== 0 && <div className="flex justify-between"><dt className="text-text-2">Round off</dt><dd className="tabular-nums">{formatINR(i.roundOff)}</dd></div>}
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatINR(i.grandTotal)}</dd></div>
        </dl>
      </Card>

      {i.corrections.length > 0 && (
        <Card>
          <CardHeader title="Corrections" description="Credit and debit notes issued against this invoice" />
          <ul className="border-t border-border text-sm">
            {i.corrections.map((c) => (
              <li key={c.id} className="flex justify-between border-b border-border px-4 py-2 last:border-0">
                <Link href={`/invoices/${c.id}`} className="underline-offset-2 hover:underline">{c.number} · {TITLE[c.documentType]}</Link>
                <span className="tabular-nums">{c.documentType === 'credit_note' ? '−' : ''}{formatINR(c.grandTotal)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {crediting && <CreditNoteDialog invoice={i} onClose={() => setCrediting(false)} />}
    </div>
  );
}

/**
 * A credit note (spec §29.4), owner only. The whole invoice — which is how an invoice is cancelled —
 * or an amount off chosen lines. Credited at the rate each line was invoiced at.
 */
function CreditNoteDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [reason, setReason] = useState('');
  const [whole, setWhole] = useState(true);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const lines = Object.entries(amounts).filter(([, v]) => v && Number(v) > 0).map(([invoiceLineId, amount]) => ({ invoiceLineId, amount }));

  const issue = useMutation({
    mutationFn: () => api<Invoice>(`/invoices/${invoice.id}/credit-note`, {
      method: 'POST', idempotencyKey: key.current, body: { reason: reason.trim(), lines: whole ? undefined : lines },
    }),
    onSuccess: (cn) => {
      void qc.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      toast('success', `${cn.number} issued`);
      router.push(`/invoices/${cn.id}`);
    },
  });

  return (
    <Dialog open onClose={onClose} size="lg" title={`Credit note against ${invoice.number}`}
      description="The invoice itself never changes. A credit note is a new document that reduces it."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={issue.isPending} disabled={reason.trim().length < 3 || (!whole && lines.length === 0)} onClick={() => issue.mutate()}>
          Issue credit note
        </Button>
      </>}>
      <div className="flex flex-col gap-4 text-sm">
        {issue.error && <ErrorBanner message={(issue.error as Error).message} />}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="How much">
          <button type="button" role="radio" aria-checked={whole} onClick={() => setWhole(true)} className={whole ? 'rounded-md bg-surface px-3 py-2 font-medium shadow-sm' : 'rounded-md px-3 py-2 text-text-2'}>Whole invoice (cancel)</button>
          <button type="button" role="radio" aria-checked={!whole} onClick={() => setWhole(false)} className={!whole ? 'rounded-md bg-surface px-3 py-2 font-medium shadow-sm' : 'rounded-md px-3 py-2 text-text-2'}>Part of some lines</button>
        </div>
        {!whole && (
          <div className="flex flex-col gap-2">
            {invoice.lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3">
                <span>{l.description} <span className="text-text-3">· {formatINR(l.taxable)} at {Number(l.gstRate)}%</span></span>
                <Input className="w-32" inputMode="decimal" placeholder="Amount" aria-label={`Amount to credit on ${l.description}`}
                  value={amounts[l.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })} />
              </div>
            ))}
            <p className="text-xs text-text-3">Amounts are before GST; the tax is credited at the line's original rate.</p>
          </div>
        )}
        <Field label="Reason" required hint="Printed on the credit note">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Guest disputed the laundry charge" />}
        </Field>
      </div>
    </Dialog>
  );
}
