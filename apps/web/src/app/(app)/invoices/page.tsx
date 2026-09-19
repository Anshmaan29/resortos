'use client';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatINR, money } from '@resortos/shared';
import { DateField } from '@/components/ui/date-field';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { InvoiceRegisterRow } from '@/lib/types';

const LABEL = { tax_invoice: 'Invoice', bill_of_supply: 'Bill of supply', credit_note: 'Credit note', debit_note: 'Debit note' } as const;

/** The invoice register (owner): every GST document in a period, in number order. */
export default function InvoicesPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useQuery({
    queryKey: ['invoices', from, to],
    queryFn: () => api<InvoiceRegisterRow[]>('/invoices', { query: { from: from || undefined, to: to || undefined } }),
  });
  const rows = list.data ?? [];
  const sign = (r: InvoiceRegisterRow) => (r.documentType === 'credit_note' ? -1 : 1);
  const total = (k: 'taxable' | 'cgst' | 'sgst' | 'total') => rows.reduce((t, r) => t.plus(money(r[k]).times(sign(r))), money(0)).toFixed(2);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description="Every tax invoice, bill of supply, credit note and debit note. Issued documents never change."
        actions={<div className="flex items-end gap-2"><DateField label="From" value={from} onChange={setFrom} /><DateField label="To" value={to} onChange={setTo} /></div>}
      />
      {list.isLoading ? <Skeleton className="h-48" /> : list.isError ? (
        <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<FileText className="h-5 w-5" />} title="No invoices in this period" description="An invoice is issued when a guest checks out." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-text-3">
                <tr className="border-b border-border">
                  <th scope="col" className="px-4 py-2 font-medium">Number</th>
                  <th scope="col" className="px-4 py-2 font-medium">Date</th>
                  <th scope="col" className="px-4 py-2 font-medium">Billed to</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Taxable</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">CGST + SGST</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="whitespace-nowrap px-4 py-2">
                      <Link href={`/invoices/${r.id}`} className="font-medium underline-offset-2 hover:underline">{r.number}</Link>
                      <span className="ml-2 text-xs text-text-3">{LABEL[r.documentType]}{r.originalNumber ? ` · against ${r.originalNumber}` : ''}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(r.invoiceDate)}</td>
                    <td className="px-4 py-2">{r.buyerName}{r.buyerGstin && <span className="ml-2 text-xs text-text-3">{r.buyerGstin}</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{sign(r) < 0 ? '−' : ''}{formatINR(r.taxable)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{sign(r) < 0 ? '−' : ''}{formatINR(money(r.cgst).plus(r.sgst).toFixed(2))}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{sign(r) < 0 ? '−' : ''}{formatINR(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-4 py-2" colSpan={3}>Net for the period</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(total('taxable'))}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(money(total('cgst')).plus(total('sgst')).toFixed(2))}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(total('total'))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
