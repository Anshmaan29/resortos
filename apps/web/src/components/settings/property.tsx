'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GST_STATE_CODES, isValidGstin } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { Property, PropertyPolicies } from '@/lib/types';
import { Section, Toggle, useSave } from './common';

const useProp = () => useQuery({ queryKey: ['property'], queryFn: () => api<Property>('/property') });

/** Who the resort is (spec §9): what every invoice, receipt and message says about it. */
export function PropertySettings() {
  const prop = useProp();
  const [f, setF] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (prop.data && !f) {
      const p = prop.data;
      setF({ name: p.name, legalName: p.legalName, addressLine1: p.addressLine1, addressLine2: p.addressLine2 ?? '', city: p.city, stateCode: p.stateCode,
        pinCode: p.pinCode, gstin: p.gstin ?? '', phone: p.phone, email: p.email ?? '', checkInTime: p.checkInTime, checkOutTime: p.checkOutTime });
    }
  }, [prop.data, f]);
  const save = useSave(() => api('/property', { method: 'PATCH', body: { ...f, version: prop.data!.version } }), {
    invalidate: [['property']], success: 'Property saved', onDone: () => setF(null),
  });
  if (!prop.data || !f) return <Skeleton className="h-96" />;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const gstinBad = f.gstin && (!isValidGstin(f.gstin) || f.gstin.slice(0, 2) !== f.stateCode);
  return (
    <Section title="Property" description="Printed on every invoice and receipt, and used in guest messages. Invoices already issued keep what they said."
      action={<Button loading={save.isPending} disabled={Boolean(gstinBad)} onClick={() => save.mutate(undefined)}>Save</Button>}>
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Resort name" required error={save.fields.name}>{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Legal name" required hint="As registered for GST" error={save.fields.legalName}>{(id) => <Input id={id} value={f.legalName} onChange={set('legalName')} />}</Field>
        <Field label="Address" required className="sm:col-span-2" error={save.fields.addressLine1}>{(id) => <Input id={id} value={f.addressLine1} onChange={set('addressLine1')} />}</Field>
        <Field label="Address line 2" className="sm:col-span-2">{(id) => <Input id={id} value={f.addressLine2} onChange={set('addressLine2')} />}</Field>
        <Field label="City" required>{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
        <Field label="PIN code" required error={save.fields.pinCode}>{(id) => <Input id={id} inputMode="numeric" value={f.pinCode} onChange={set('pinCode')} maxLength={6} />}</Field>
        <Field label="State" required>{(id) => (
          <Select id={id} value={f.stateCode} onChange={set('stateCode')}>
            {Object.entries(GST_STATE_CODES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
          </Select>)}</Field>
        <Field label="GSTIN" hint="Leave empty if not registered — invoices then become bills of supply with no tax"
          error={gstinBad ? 'Not a valid GSTIN for this state' : save.fields.gstin}>
          {(id) => <Input id={id} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} />}</Field>
        <Field label="Phone" required error={save.fields.phone}>{(id) => <Input id={id} value={f.phone} onChange={set('phone')} />}</Field>
        <Field label="Email" error={save.fields.email}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}</Field>
        <Field label="Check-in time" required>{(id) => <Input id={id} type="time" value={f.checkInTime} onChange={set('checkInTime')} />}</Field>
        <Field label="Checkout time" required>{(id) => <Input id={id} type="time" value={f.checkOutTime} onChange={set('checkOutTime')} />}</Field>
      </div>
    </Section>
  );
}

/** The owner's rules for the desk, printouts and guest email. */
export function PolicySettings() {
  const prop = useProp();
  const [f, setF] = useState<PropertyPolicies | null>(null);
  useEffect(() => { if (prop.data && !f) setF(prop.data.policies); }, [prop.data, f]);
  const save = useSave(() => api<Property>('/property/policies', { method: 'PATCH', body: { ...f, version: prop.data!.version } }), {
    invalidate: [['property']], success: 'Policies saved', onDone: () => setF(null),
  });
  if (!prop.data || !f) return <Skeleton className="h-96" />;
  const text = (k: keyof PropertyPolicies) => ({ value: (f[k] as string | null) ?? '', onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const flag = (k: keyof PropertyPolicies) => ({ checked: Boolean(f[k]), onChange: (v: boolean) => setF({ ...f, [k]: v }) });
  const saveButton = <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>;
  return (
    <div className="flex flex-col gap-5">
      {save.error && <ErrorBanner message={(save.error as Error).message} />}
      <Section title="Desk and review" description="Limits the server enforces, and what reaches your review list." action={saveButton}>
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <Field label="Cash difference needing a reason (₹)" hint="Also shown on the review list">{(id) => <Input id={id} inputMode="decimal" {...text('cashDifferenceThreshold')} />}</Field>
          <Field label="Discounts above this % are reviewed">{(id) => <Input id={id} inputMode="decimal" {...text('reviewDiscountPercent')} />}</Field>
          <Field label="Lock a shared desk after (minutes)" error={save.fields.deskLockMinutes}>{(id) => <Input id={id} inputMode="numeric" value={String(f.deskLockMinutes)} onChange={(e) => setF({ ...f, deskLockMinutes: Number(e.target.value) || 0 })} />}</Field>
          <div className="sm:col-span-3"><Toggle label="Receptionists may run night audit" hint="Otherwise only the owner can close the day" {...flag('receptionistCanRunNightAudit')} /></div>
        </div>
      </Section>
      <Section title="Printing" description="What invoices and receipts say beyond the transaction." action={saveButton}>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Terms under the invoice" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} maxLength={1000} {...text('invoiceTerms')} />}</Field>
          <Field label="Bank / UPI details for paying later" className="sm:col-span-2">{(id) => <Input id={id} maxLength={500} {...text('invoiceBankDetails')} />}</Field>
          <Field label="Receipt printer">{(id) => (
            <Select id={id} value={f.receiptPaper} onChange={(e) => setF({ ...f, receiptPaper: e.target.value as 'a4' | 'thermal_80' })}>
              <option value="a4">A4 printer</option><option value="thermal_80">80 mm thermal roll</option>
            </Select>)}</Field>
          <Toggle label="Mask guest mobile on printouts" hint="Shows only the last 4 digits" {...flag('printMaskMobile')} />
        </div>
      </Section>
      <Section title="Guest email" description="Sent through Resend. Switch on only after the sending domain is verified (SPF, DKIM, DMARC)." action={saveButton}>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Toggle label="Send guest emails" hint="Booking confirmation, welcome, checkout reminder, invoice and receipts" {...flag('emailEnabled')} /></div>
          <Field label="Sender name">{(id) => <Input id={id} placeholder={prop.data!.name} {...text('emailFromName')} />}</Field>
          <Field label="Sender address" hint="On your verified domain" error={save.fields.emailFromAddress}>{(id) => <Input id={id} type="email" placeholder="stay@yourresort.com" {...text('emailFromAddress')} />}</Field>
          <Field label="Replies go to" error={save.fields.emailReplyTo}>{(id) => <Input id={id} type="email" {...text('emailReplyTo')} />}</Field>
          <Field label="Reception phone in messages">{(id) => <Input id={id} {...text('receptionPhone')} />}</Field>
          <Field label="Wi-Fi details">{(id) => <Input id={id} placeholder="Network ArvaliGuest · password on your key card" {...text('wifiDetails')} />}</Field>
          <Field label="Map link" error={save.fields.locationLink}>{(id) => <Input id={id} placeholder="https://maps.app.goo.gl/…" {...text('locationLink')} />}</Field>
          <Field label="Quiet hours from" hint="Reminders wait until they end">{(id) => <Input id={id} type="time" {...text('quietHoursStart')} />}</Field>
          <Field label="Quiet hours until">{(id) => <Input id={id} type="time" {...text('quietHoursEnd')} />}</Field>
          <Field label="Checkout reminder at" hint="The evening before departure">{(id) => <Input id={id} type="time" {...text('checkoutReminderTime')} />}</Field>
          <Toggle label="Skip the reminder for a one-night stay checked in that afternoon" {...flag('reminderSkipSameDay')} />
        </div>
      </Section>
    </div>
  );
}
