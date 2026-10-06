'use client';
import { useQuery } from '@tanstack/react-query';
import { Building2, CalendarDays, FileSpreadsheet, FileText, Landmark, MoonStar, ShieldCheck, Users, Wallet } from 'lucide-react';
import { useState } from 'react';
import { addDays, formatDate, todayIn } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { useMe, useProperty } from '@/lib/session';
import { SheetsSync } from '@/components/records/sheets-sync';
import { PoliceRegisterTable } from '@/components/records/police-register-table';

/**
 * The records area (spec §43, §46): the owner's data, in plain language, as files they already
 * understand. Every download is a real file from the API, and the API logs every one of them.
 */

interface Range { from: string; to: string; label: string }

const RECORDS: { kind: string; title: string; description: string; icon: typeof Users; range: boolean }[] = [
  { kind: 'bookings', title: 'Bookings', description: 'Bookings arriving in the selected range, cancelled ones included', icon: CalendarDays, range: true },
  { kind: 'guests', title: 'Guests', description: 'Guest directory with contacts', icon: Users, range: false },
  { kind: 'in-house', title: 'Stays', description: 'Stays arriving in the selected range, room by room', icon: Building2, range: true },
  { kind: 'payments', title: 'Payments', description: 'Money taken, refund by refund', icon: Wallet, range: true },
  { kind: 'invoices', title: 'Bills & invoices', description: 'Tax invoices, bills of supply, credit and debit notes', icon: FileText, range: true },
  { kind: 'expenses', title: 'Expenses', description: 'Money paid out, category by category', icon: Landmark, range: true },
  { kind: 'daily-summaries', title: 'Daily summaries', description: 'What each closed business day looked like', icon: MoonStar, range: true },
  { kind: 'form-c', title: 'Form C', description: 'Foreign guest reports, with passport and visa details', icon: ShieldCheck, range: false },
  { kind: 'police-register', title: 'Police register', description: 'One row per guest for the station\'s book, in its columns', icon: FileSpreadsheet, range: true },
];

export default function RecordsPage() {
  const me = useMe();
  const property = useProperty();
  const businessDate = property.data?.businessDate ?? todayIn();
  const [range, setRange] = useState<Range>(thisMonth(businessDate));

  if (me.data && me.data.role !== 'owner') {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Records" />
        <Card><EmptyState icon={<FileSpreadsheet className="h-5 w-5" />} title="The records are the owner's" description="Ask the owner if you need something from here." /></Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Records"
        description="Your resort's data, ready to open in Excel or hand to the accountant. Every download is recorded in the audit log."
      />

      <Card>
        <CardHeader title="Download all records" description="One Excel file with all dates: bookings, guests, stays, payments, invoices, expenses and registers. Photos are available from each guest or stay." />
        <div className="p-4"><DownloadLink href="/api/v1/exports/all.xlsx" kind="secondary">Download all records (Excel)</DownloadLink></div>
      </Card>
      <SheetsSync />

      <Card>
        <CardHeader title="Date range" description="Applies to the records that depend on dates." />
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          {presets(businessDate).map((r) => (
            <Button key={r.label} size="sm" variant={range.from === r.from && range.to === r.to ? 'primary' : 'ghost'} onClick={() => setRange(r)}>
              {r.label}
            </Button>
          ))}
          <div className="ms-auto flex items-center gap-2 text-sm text-text-3">
            {formatDate(range.from)} – {formatDate(range.to)}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {RECORDS.map(({ kind, title, description, icon: Icon, range: needsRange }) => {
          const r = needsRange ? range : { from: '', to: '', label: '' };
          const qs = needsRange ? `?from=${r.from}&to=${r.to}` : '';
          return (
            <Card key={kind} className="flex flex-col">
              <div className="flex items-start gap-3 px-4 pt-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2"><Icon className="h-5 w-5" /></span>
                <div>
                  <h3 className="font-medium">{title}</h3>
                  <p className="text-sm text-text-3">{description}</p>
                </div>
              </div>
              <div className="mt-auto flex gap-2 px-4 pb-4 pt-3">
                <DownloadLink href={`/api/v1/exports/${kind}.xlsx${qs}`} kind="secondary">Download Excel</DownloadLink>
                <DownloadLink href={`/api/v1/exports/${kind}.csv${qs}`}>CSV</DownloadLink>
                {kind === 'police-register' && (
                  <DownloadLink href={`/api/v1/exports/${kind}.pdf${qs}`}>PDF</DownloadLink>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="For the accountant" description="Tax summaries for your accountant. Confirm the ledger mapping and a sample import before using Tally vouchers." />
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <DownloadLink kind="secondary" href={`/api/v1/exports/gstr-1.csv?from=${range.from}&to=${range.to}`}>GSTR-1 ready (CSV)</DownloadLink>
          <DownloadLink kind="secondary" href={`/api/v1/exports/tally.xml?from=${range.from}&to=${range.to}`}>Tally vouchers (XML)</DownloadLink>
        </div>
      </Card>

      <PoliceRegisterSection from={range.from} to={range.to} />
    </div>
  );
}

/** The register on screen, above its downloads (§58.2). */
function PoliceRegisterSection({ from, to }: { from: string; to: string }) {
  const register = useQuery({
    queryKey: ['police-register', from, to],
    queryFn: () => api<{ propertyName: string; from: string; to: string; columns: { key: string; label: string }[]; rows: string[][] }>(`/police-register?from=${from}&to=${to}`),
  });
  return (
    <Card>
      <CardHeader title="Police register on screen" description={`One row per guest who checked in ${from === to ? `on ${formatDate(from)}` : `between ${formatDate(from)} and ${formatDate(to)}`}. The columns follow the property setting.`} />
      {register.isLoading ? <Skeleton className="m-4 h-40" />
        : register.isError ? <ErrorBanner message={(register.error as Error).message} onRetry={() => register.refetch()} />
        : (register.data?.rows ?? []).length === 0 ? (
          <EmptyState icon={<FileSpreadsheet className="h-5 w-5" />} title="No guests checked in for this range" />
        ) : (
          <PoliceRegisterTable columns={register.data!.columns} rows={register.data!.rows} />
        )}
    </Card>
  );
}

function presets(businessDate: string): Range[] {
  const d = new Date(`${businessDate}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = (yy: number, mm: number, dd: number) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const fyStart = m >= 3 ? y : y - 1;
  return [
    { label: 'Today', from: businessDate, to: businessDate },
    { label: 'Yesterday', from: addDays(businessDate, -1), to: addDays(businessDate, -1) },
    { label: 'This week', from: addDays(businessDate, -((d.getUTCDay() + 6) % 7)), to: businessDate },
    { label: 'This month', from: day(y, m, 1), to: day(y, m, monthEnd(y, m)) },
    { label: 'Last month', from: day(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1), to: day(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, monthEnd(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1)) },
    { label: 'This financial year', from: `${fyStart}-04-01`, to: businessDate },
  ];
}

function thisMonth(businessDate: string): Range {
  const p = presets(businessDate);
  return p[3]!;
}

/** A download that looks like a button: same-origin href, so the session cookie rides along. */
function DownloadLink({ href, children, kind = 'ghost' }: { href: string; children: React.ReactNode; kind?: 'secondary' | 'ghost' }) {
  return (
    <a href={href}
      className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm ${kind === 'secondary' ? 'bg-surface-2 text-text hover:bg-surface-3' : 'text-text-2 hover:bg-surface-2 hover:text-text'}`}>
      {children}
    </a>
  );
}
