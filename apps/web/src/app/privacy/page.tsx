import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'Guest data and messaging privacy for Lakshmi Palace by Voitto, Villa Sol by Voitto and ResortOS.',
  robots: { index: true, follow: false },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
      <Link href="/login" className="text-sm font-medium text-brand underline underline-offset-4">ResortOS</Link>
      <article className="mt-6 rounded-xl border border-border bg-surface p-6 sm:p-10">
        <header className="mb-8 border-b border-border pb-6">
          <p className="mb-2 text-sm text-text-2">Lakshmi Palace by Voitto · Villa Sol by Voitto · Voitto Ventures</p>
          <h1 className="text-3xl font-semibold tracking-tight">Privacy policy</h1>
          <p className="mt-3 text-sm text-text-2">Updated 17 October 2026</p>
        </header>
        <div className="space-y-7 text-base leading-7 text-text-2 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text">
          <section>
            <h2>About this service</h2>
            <p>This notice covers Lakshmi Palace by Voitto and Villa Sol by Voitto. Each property keeps separate operational records. It describes how each property uses ResortOS to manage reservations, stays, guest records, billing and guest messages. The Meta app named Voittoventures connects the hotel to the WhatsApp Business Platform. Contact the hotel reception for questions about your information.</p>
          </section>
          <section>
            <h2>Information we handle</h2>
            <p>Depending on your reservation and stay, records may include your name, contact details, address, booking dates, room, guest count, charges, payment records and invoices. Guest registration may also include identity details, uploaded identity documents, an optional guest photograph and an optional signature. Saved identity details and available ID documents may be reused for a returning guest’s new registration at the same property. Staff access and changes, messaging consent and message delivery statuses are recorded to help operate the hotel and resolve problems.</p>
          </section>
          <section>
            <h2>How the information is used</h2>
            <p>The hotel uses these records to arrange your booking and check-in, provide your stay, maintain guest registration records, issue bills and receipts, manage payments and respond to enquiries. Authorised hotel staff use ResortOS accounts to access the records needed for their work.</p>
          </section>
          <section>
            <h2>WhatsApp and email messages</h2>
            <p>WhatsApp messages require your agreement. They may include booking confirmations, check-in information, checkout reminders, invoices and payment receipts. Your phone number and the information needed for the selected message, such as your name, booking dates or billing details, are processed by Meta through the WhatsApp Business Platform. Delivery identifiers and delivery statuses are stored in ResortOS.</p>
            <p className="mt-3">Identity document images, guest photographs and signatures are not attached to WhatsApp or email messages. Invoice and receipt messages may include a PDF containing the relevant billing information. Transactional emails are delivered through Resend. Meta and Resend process information according to their own privacy policies.</p>
            <p className="mt-3">To stop WhatsApp notifications, ask reception to withdraw your WhatsApp messaging consent. This does not cancel your reservation or remove records that the hotel needs to retain. This integration is used for stay-related messages; it does not send marketing campaigns.</p>
          </section>
          <section>
            <h2>Hosting and access</h2>
            <p>ResortOS is hosted on Railway and uses configured database and document storage services. Hotel records are accessed through authenticated staff accounts, and uploaded documents use controlled access. Service providers receive information needed to operate hosting, storage or message delivery. Records may also be disclosed when necessary to meet applicable legal obligations.</p>
          </section>
          <section>
            <h2>Retention and your requests</h2>
            <p>The hotel retains records for operational, accounting, guest-registration and applicable legal requirements. Contact reception to request access, correction or deletion of your information, or to withdraw messaging consent. Reception may need to verify your identity. Some records may need to be retained even after a deletion request because of accounting, legal or dispute-related obligations.</p>
          </section>
          <section id="contact">
            <h2>Contact the hotel</h2>
            <p>For privacy questions or a data request, contact your property’s reception in person. Villa Sol reception: +91 93522 04825. Lakshmi Palace reception: <a href="tel:+919829204128" className="font-medium text-brand underline underline-offset-4">+91 98292 04128</a>. Please provide enough information to identify your booking without sending identity document photos or passwords through an unverified channel.</p>
          </section>
        </div>
      </article>
    </main>
  );
}
