# ResortOS — Complete Resort Management System

## Master Product + Engineering Specification v4

> **Purpose:** Build ResortOS, a production-grade cloud resort management
> system (PMS) for Indian resorts. It must be very easy for non-technical
> owners and receptionists on desktop and phone, while bookings, guests,
> bills, and documents are strictly protected and never lost.
>
> **This document replaces v3.** Where v4 and older versions differ, v4
> wins.

---

## What changed in v4

**Decisions confirmed by the product owner:**

- Only two primary login roles: **Owner** and **Receptionist**. No
  manager role. Optional task-only cleaner accounts stay.
- Login uses **username or phone number + password**. OTP is optional,
  not required.
- **No payment gateway, payment links, or online payments.** Resorts
  use their own card POS machine and UPI QR; ResortOS only records
  payments.
- **No restaurant system.** Food, activities, and other extras are
  added to the bill as named charge lines (for example "Paneer Tikka ×2",
  "Jeep Safari").
- **Phone as a scanner:** a QR code on the desk screen lets a phone
  capture guest photos and ID documents into the current check-in.
- **Easy data access for non-technical owners:** an in-app Records area,
  a read-only Google Sheets mirror, and a monthly archive to the owner's
  Google Drive.
- **Exactly one AI feature: AI Revenue Intelligence**, advisory only,
  built only in its easy form (section 64). AI risk/anomaly detection is
  removed.

**Restored from v2 (accidentally dropped in v3):**

- Night audit and business date
- Explicit GST slab rule, Tally export, GSTR-1 export, e-invoicing switch
- Detailed camera and document capture requirements
- Owner daily summary specification

**New in v4:**

- Detailed photo/document capture, including phone-as-scanner (section 19)
- Group bookings and split bills
- Money handling on cancellation and no-show
- Receptionist limits with on-screen Owner PIN override (no approval queue)
- Invoice numbering from a locked counter (no gaps)
- Backups across a second, independent provider; file storage and
  encryption key backup; tamper-evident audit log
- Owner "Data Safety" panel in plain language
- UI design system and motion/animation rules
- Pilot / parallel-run plan and vendor responsibilities

---

# PART A — SCOPE AND PRINCIPLES

# 1. Scope Decisions

## 1.1 Not part of v4

Do **not** build:

1. Manager role or any approval-queue / approval-matrix workflow
2. Payment gateway, payment links, online payments, Razorpay
3. Restaurant, POS, KOT, menu management, kitchen workflow
4. AI chatbot, AI receptionist, AI voice, AI-generated guest messages
5. AI OCR or AI identity extraction
6. AI risk/anomaly/fraud detection
7. Any AI that changes prices, bookings, payments, refunds, or invoices
8. Complex cancellation-policy engine
9. Full two-way offline synchronization
10. Microservices
11. Google Sheets as a database, or reading data back from Google Sheets
12. A channel manager built in-house (integration with an existing one is
    a later phase, section 82)

## 1.2 Simplified on purpose

| Area | v4 approach |
|---|---|
| Roles | Owner + Receptionist (+ optional task-only Cleaner) |
| Login | Username/phone + password; optional OTP/authenticator for owner |
| Payments | Record method + reference only (POS machine, UPI QR, cash, bank) |
| Food / activities | Named charge lines on the folio, with a quick-pick list |
| Cancellation | One Cancel action + a required choice of what happens to money already paid |
| Sensitive actions | Receptionist limits; Owner PIN entered on the same screen to go beyond them |
| Alerts | Simple rule-based owner review list (no AI) |

## 1.3 The only AI feature

**AI Revenue Intelligence** (Part I). It is advisory only and is built
only in the easy form defined in section 64. If that form cannot be
delivered reliably, ship the non-AI Revenue dashboard (section 63)
and leave the AI switched off. The core product must never depend on it.

---

# 2. Product Vision

ResortOS combines:

- Front desk: reservations, calendar, check-in, checkout, room shifts
- Guest profiles and history
- Room status and housekeeping
- Maintenance
- Folios, food/activity charges, payment recording, GST invoices
- Company billing and OTA booking tracking
- Cashier shifts and night audit
- Expenses
- Reports and exports (Excel, PDF, Tally, GSTR-1)
- Guest WhatsApp/email messages
- Owner daily summary
- Google Sheets mirror and Google Drive archive for easy owner access
- India compliance: GST, Form C, police register, DPDP
- Data migration from the old software
- Audit history
- AI Revenue Intelligence (advisory)

It must feel like a modern, polished app, not a legacy database form.

---

# 3. Core Principles

> **A receptionist with no technical or accounting knowledge must be able
> to run the normal hotel day correctly. An owner with no technical
> knowledge must be able to see and trust their data.**

Priority order:

**Data safety → Correctness → Security → Usability → Reliability →
Performance → Features**

Rules that apply everywhere:

1. PostgreSQL is the only source of truth.
2. The backend enforces every business rule and permission; the frontend
   only helps.
3. Multi-step operations run in one database transaction.
4. Critical records are never hard-deleted; corrections create new
   records.
5. Every important action is audit-logged against a real individual.
6. Double booking is impossible at the database level.
7. Repeated clicks or network retries never create duplicates.
8. External services (WhatsApp, email, Google, AI) can fail without
   affecting bookings, bills, or data.
9. Nothing shows "success" unless the server has committed it.
10. No software can promise literal zero errors or zero data loss; the
    system is built with layered protection so that errors are blocked,
    visible, and recoverable (sections 47–56).

---

# 4. Users and Roles

## 4.1 Owner

Full access:

- Everything a receptionist can do
- Refunds, credit notes, invoice corrections
- Discounts and rate overrides beyond receptionist limits
- Users, passwords, permissions, limits
- Property, rooms, rates, taxes, charge items, invoice settings
- Reports, exports, Records area, Google Sheets/Drive settings
- Revenue Intelligence
- Owner review list (section 34.4)
- Audit log
- Data Safety panel (section 53.7)
- Compliance settings, data migration

An owner can have more than one owner account (for example two partners),
each with its own login.

## 4.2 Receptionist

- Dashboard, reservations, calendar, walk-in
- Check-in, checkout, room shift
- Guest search and profiles
- Add food/activity/other charges
- Record payments and advances
- Discounts up to their limit
- Print/send invoices and receipts
- Cashier shift open/close
- Night audit (if allowed by owner setting)
- Housekeeping and maintenance requests
- Form C preparation and police register export (if allowed)

A receptionist cannot see: users, settings, audit log, Revenue
Intelligence, Data Safety controls, Google settings, full exports.

## 4.3 Optional Cleaner (disabled by default)

- Task-only login or secure task link
- Sees only assigned cleaning/maintenance tasks
- No guest names beyond room number, no financial data
- Buttons: `START CLEANING`, `ROOM CLEANED ✓`
- Completion records user and time; room becomes Clean (or Inspection
  required if the property uses inspection)

## 4.4 Individual identity

Every person has their own account. Never create a shared
"reception" login. Every action is recorded against the real user.

## 4.5 Receptionist limits and Owner PIN

There is no approval queue. Instead, limits are enforced on the backend,
and the owner can authorise an exception **on the same screen**:

| Action | Receptionist | Beyond limit |
|---|---|---|
| Discount on a folio | Up to X% (default 10%) | Owner PIN |
| Rate below the rate plan's minimum | Not allowed | Owner PIN |
| Remove a charge line (before invoice, same business date) | Allowed with reason | — |
| Remove a charge line after night audit | Not allowed | Owner only |
| Refund | Not allowed | Owner PIN |
| Credit note / invoice correction | Not allowed | Owner only |
| Cash shift difference above threshold | Must enter reason | Shown on owner review list |

Owner PIN flow:

```text
Receptionist enters 20% discount
      ↓
"This needs owner authorisation"
      ↓
Owner (present at desk) enters their 6-digit PIN
      ↓
Backend verifies PIN, applies discount
      ↓
Audit: performed by Receptionist 01, authorised by Owner, reason
```

If the owner is not present, the owner can do the action from their own
phone login instead.

Owner PIN rules: separate from the owner's password, rate-limited, locked
after 5 wrong attempts, and every use is audit-logged.

---

# 5. Login and Sessions

## 5.1 Login

```text
Username or phone number
Password
[LOG IN]
```

- Passwords hashed with **Argon2id** (never stored or logged in plain text)
- Minimum 10 characters; block common passwords
- Rate limiting per account and per IP
- Lock account for 15 minutes after 5 failed attempts; owner can unlock
- Show a generic error ("Username or password is incorrect")

## 5.2 Password reset

- **Receptionist / cleaner:** owner sets a temporary password from Users;
  user must change it at next login
- **Owner:** reset through the owner's verified email, plus printed
  one-time **recovery codes** generated at setup (stored hashed)
- Optional for owner (recommended): authenticator-app 2FA (TOTP)
- Optional: SMS/WhatsApp OTP if the property configures a provider;
  login must never *depend* on SMS

## 5.3 Shared front-desk computers

- Owner marks a computer as a trusted device
- On a trusted device: staff choose their name and enter a personal
  4–6 digit PIN to switch users quickly after a full password login
  earlier that day
- Auto-lock after configurable inactivity (default 5 minutes)
- Sensitive screens (ID images, exports) ask for PIN again
- Owner can see and log out all sessions and devices

## 5.4 Sessions

- Secure, HttpOnly, SameSite cookies
- Session expiry (for example 12 hours on trusted devices, 8 hours
  elsewhere; configurable)
- Password change logs out other sessions

---

# 6. Platforms

Must work well on:

- Desktop/laptop browsers (Chrome, Edge, Safari) — primary for reception
- Android phones and iPhones (Chrome, Safari) — owner, cleaner, phone
  scanner
- Tablets

Installable as a **PWA**. No native app in v4.

Performance targets (on a mid-range Android phone over 4G):

- First load under 3 seconds
- Screen changes under 300 ms
- Button feedback under 100 ms

---

# 7. Technology Stack

## Frontend

- Next.js (App Router), React, TypeScript (strict mode)
- Tailwind CSS + shadcn/ui
- Motion (formerly Framer Motion) for animation
- React Hook Form + Zod
- TanStack Query
- Recharts (charts)
- OpenCV.js or jscanify (document edge detection, lazy-loaded)
- signature_pad (signatures)

## Backend

- NestJS, TypeScript, REST, OpenAPI/Swagger
- Zod or class-validator DTO validation
- Prisma or Drizzle ORM, plus raw SQL migrations for constraints
  (exclusion constraints, triggers)
- **pg-boss** (PostgreSQL-backed job queue) with a transactional outbox

> Why pg-boss instead of Redis/BullMQ: jobs live in the same PostgreSQL
> database, are covered by the same backups, and are created in the same
> transaction as the business change. One less system that can lose
> jobs. Redis can be added later for caching only if needed.

## Database

- PostgreSQL 16+ (managed, India region)

## File storage

- S3-compatible private object storage (AWS S3 in India region
  recommended) with versioning and replication

## Integrations

- WhatsApp Business API through a provider (abstraction layer)
- Email provider (Amazon SES, Resend, or similar)
- Google Sheets API and Google Drive API
- LLM API for Revenue Intelligence explanations only (behind a provider
  interface, server-side key)

## Quality

- Vitest (unit), Supertest (API), Playwright (end-to-end, including
  mobile viewports)
- Sentry (errors), structured JSON logs, uptime monitoring

---

# 8. Architecture

## 8.1 Modular monolith

One backend application with clear modules:

```text
ResortOS API
├── auth            users, sessions, PINs, devices
├── property        property, rooms, room types, settings
├── rates           rate plans, meal plans, charge items, tax rates
├── guests          profiles, occupants, vehicles, documents, consent
├── reservations    bookings, groups, allocations, cancellation
├── stays           check-in, room shift, checkout
├── billing         folios, charges, payments, invoices, credit notes
├── shifts          cashier shifts, night audit, business date
├── housekeeping
├── maintenance
├── expenses
├── notifications   templates, outbox delivery, owner summary
├── records         owner Records area, exports, Sheets mirror, Drive archive
├── compliance      Form C, police register, DPDP requests
├── reports
├── revenue-intel   metrics, forecast, AI explanations (isolated)
├── migration       import from old software
├── safety          backup status, integrity checks, Data Safety panel
└── audit
```

Each module owns its tables, validation, authorization, and tests.
Modules never write directly to another module's tables; they call its
service.

## 8.2 Transaction + outbox

```text
Request
  ↓ authenticate
  ↓ authorize (role, limits, Owner PIN if needed)
  ↓ validate input (schema)
  ↓ BEGIN TRANSACTION
  ↓   validate current state (row locks where needed)
  ↓   business changes
  ↓   audit record
  ↓   outbox events (WhatsApp, Sheets sync, etc.)
  ↓ COMMIT
  ↓
Return the committed result

Workers (after commit)
  ├── WhatsApp / email
  ├── Google Sheets mirror
  ├── PDF generation
  └── Revenue Intelligence refresh
```

If a worker fails, it retries with backoff. The business record is
already safe. Failures are visible in the Data Safety panel.

---

# PART B — FRONT DESK

# 9. Property and Room Setup

Property:

- Resort name, legal name, address, state and state code
- GSTIN, phone, email, logo
- Check-in time, checkout time
- Timezone (Asia/Kolkata default)
- Financial year start (April)

Rooms:

- Room number (unique within property)
- Room type
- Building / block, floor
- Unit type: room, cottage, villa, tent, suite
- View: pool, garden, lake, hill, other
- Base and maximum occupancy
- Connecting room, accessibility
- Amenities
- Notes
- Active / inactive (never delete a room with history)

Room types: configurable (for example Standard, Deluxe, Premium Cottage,
Suite).

---

# 10. Room Status Model

Three independent dimensions per room:

```text
Occupancy:     Vacant | Occupied | Arriving today | Due out today
Housekeeping:  Dirty | Cleaning | Clean | Inspected
Service:       In service | Maintenance | Out of order
```

- **Sellable** = Vacant + (Clean or Inspected) + In service
- Out-of-order rooms are excluded from available-room counts in
  occupancy and RevPAR
- Every change is written to `room_status_history` (who, when, from, to)

Display label is derived, for example "Occupied · Dirty" (stayover
needs service) or "Vacant · Ready".

---

# 11. Rate Plans, Meal Plans and Occupancy Pricing

## 11.1 Rate plans

- Base rate per room type
- Date-range overrides: season, weekend, festival, long weekend
- Day-of-week rates
- Corporate / travel-agent rates
- Minimum rate (floor) per room type — below this needs Owner PIN
- Minimum stay per date range (warning, overridable by owner)
- Rate calendar screen for bulk edits

## 11.2 Meal plans

```text
EP   Room only
CP   Room + breakfast
MAP  Room + breakfast + one main meal
AP   Room + all meals
```

Meal-plan components post as separate folio lines where tax or
reporting needs it (configurable per meal plan).

## 11.3 Occupancy pricing

- Base occupancy per room type
- Extra adult charge, extra bed charge
- Child age bands (for example 0–5 free, 6–12 child rate), configurable
- Maximum occupancy enforced by the backend

## 11.4 Other stay charges

- Early check-in / late checkout: free, fixed amount, or percentage of
  the night rate (configurable)
- Day-use bookings (no overnight stay)

---

# 12. Reservations and Group Bookings

## 12.1 Views

- List with filters (date, status, source, room type)
- Calendar / timeline (section 14)
- Availability search by dates, room type, occupancy

## 12.2 Reservation fields

- Reservation number (for example `BK-000183`)
- Primary guest, mobile, email
- Source: Walk-in, Phone, WhatsApp, Direct, Website, MakeMyTrip,
  Goibibo, Booking.com, Agoda, Airbnb, Corporate, Travel agent, Other
- OTA reference (required when source is an OTA)
- Arrival, departure, nights
- Rooms (one or more), room type, assigned room (optional until check-in)
- Adults, children (with ages)
- Rate plan, meal plan, nightly rate
- Special requests, internal notes
- Status
- Created by, created at

## 12.3 Statuses

```text
Tentative → Confirmed → Checked-in → Checked-out
          ↘ Cancelled
          ↘ No-show
```

## 12.4 Group bookings

- One reservation can hold many rooms (weddings, families, corporate
  groups)
- Group name and group leader
- Assign rooms individually; check in rooms individually or all at once
- Billing mode chosen per group:
  - **One master bill** (all rooms' charges on one folio)
  - **Separate bills** per room
  - **Split**: room charges to master bill, extras to each room
- Move individual charge lines between folios in the same group (before
  invoicing, audit-logged)
- Group summary: rooms, arrived, departed, total, paid, balance

---

# 13. Double-Booking Protection

Hard database requirement.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE room_allocations
ADD CONSTRAINT no_overlapping_room_allocations
EXCLUDE USING gist (
  room_id WITH =,
  daterange(start_date, end_date, '[)') WITH &&
)
WHERE (status IN ('reserved', 'checked_in'));
```

- Half-open range `[)` allows checkout and new check-in on the same date
- Room-type level (unassigned) bookings are checked against sellable
  room count inside a transaction with a lock on the room-type inventory
  row for those dates
- The frontend shows availability, but only the database decides
- If the constraint rejects, show: "Room 204 was just booked by someone
  else. Please choose another room." and refresh availability
- Required test: two concurrent overlapping inserts — exactly one succeeds

---

# 14. Reservation Calendar

```text
Room   16    17    18    19    20    21
101    [==== Rahul ====]
102          [====== Amit ======]
103    [= Neha =]            [= Group: Sharma Wedding =]
104                OUT OF ORDER
```

- Colour by status; tap a booking to open a side drawer
- Drag to move dates or change room (confirmation dialog, server
  validates, audit-logged)
- Drag on empty cells to start a new booking
- Today line, sticky room column, horizontal scroll
- On phones: switch to a day list view

---

# 15. Cancellation and No-Show

## 15.1 Cancel

```text
[ CANCEL BOOKING ]
Reason (short list + optional note)
```

If **no money was paid**: status → Cancelled.

If **an advance was paid**, the receptionist must choose one:

| Option | Result | Who |
|---|---|---|
| Refund | Refund record (method, reference) | Owner PIN |
| Keep as cancellation charge | Cancellation charge line + invoice with GST as configured | Receptionist |
| Keep as credit for a future stay | Guest credit balance, linked to the guest profile | Receptionist |
| Partly refund, partly keep | Both records | Owner PIN |

Money is never left unattached. The booking keeps all original data;
it is never deleted.

## 15.2 No-show

During night audit (section 35), arrivals not checked in must be marked:
**No-show**, **Extend arrival to tomorrow**, or **Cancel**. No-show with
an advance uses the same money options as cancellation.

## 15.3 Statistics

Cancellation and no-show counts and rates by date, source, room type,
and lead time — calculated from reservation history, never entered by
hand.

---

# 16. Guest Profiles

Fields:

- First name, last name
- Mobile (with country code), email
- Address, city, state, PIN code, country, nationality
- Date of birth only if required
- Company name, GSTIN
- Preferences (room type, view, bed, food notes)
- Communication preferences and consent records
- Flags (section 60)
- Credit balance (from cancellations kept as credit)

Duplicate prevention:

- Search by mobile before creating
- Warn on same mobile or same name + city
- Owner can merge duplicates (history preserved, audit-logged)

History tab: stays, bills, payments, documents (permission-controlled),
notes.

Search by: mobile, name, booking number, room, invoice number, vehicle
number, OTA reference.

---

# 17. Occupants and Vehicles

## 17.1 Occupants

Every stay records all occupants per room:

- Name
- Adult / child, age for children
- Relation to primary guest (optional)
- Nationality (foreign → Form C, section 58)
- ID type, ID reference, ID image (if required)

Setting: ID required for **all adults** or **primary guest only**.
Occupant counts must match adults/children on the booking before
check-in can be confirmed.

## 17.2 Vehicles

- Registration number (Indian format validated; override allowed for
  other formats)
- Vehicle type (car, bike, bus, other)
- Parking slot (optional)
- Searchable

---

# 18. Check-in Workflow

## 18.1 Steps

```text
1 Find guest / booking
2 Guest & occupants
3 Stay & room
4 Documents (photo + ID)
5 Advance / payment (optional)
6 Registration card & signature
7 Confirm
```

- Progress bar at top; each step saves a server-side **draft**, so a
  refresh, crash, or power cut never loses entered data
- Walk-in starts at step 1 with no booking
- Returning guest (found by mobile): details pre-filled, receptionist
  confirms or edits
- Group check-in: select several rooms, repeat steps 2–4 per room

## 18.2 Confirmation screen

```text
Rahul Sharma · 2 adults
Room 204 · Deluxe · CP
16 Sep → 18 Sep (2 nights)
Estimated total   ₹8,400
Advance paid      ₹5,000
Documents        ✓ Photo  ✓ ID front  ✓ ID back
Signature        ✓

[ CONFIRM CHECK-IN ]
```

## 18.3 Transaction

```text
BEGIN
  validate guest, occupants, dates, room, rate, limits
  validate required documents are VERIFIED (section 19.6)
  create stay, allocate room (exclusion constraint)
  create folio
  record advance if given
  update room status → Occupied
  create Form C record if any foreign occupant
  audit
  outbox: welcome WhatsApp/email, Sheets sync
COMMIT
```

Idempotency key on the confirm request: double-click → one check-in.

---

# 19. Photo and Document Capture

This is a core, non-negotiable feature. It must work on real devices,
not only on a developer laptop.

## 19.1 Capture sources

| Source | When |
|---|---|
| **Phone as scanner (QR)** | Default recommendation for reception |
| Desk webcam | Guest photo at the desk |
| Device camera (phone/tablet running ResortOS) | Owner or receptionist on a phone |
| File upload | Scanned documents, photos from gallery, email attachments |

Every document slot shows: capture, upload, preview, retake, and status.

## 19.2 Phone as scanner

```text
Desk screen (check-in step 4)
  [ SCAN WITH PHONE ]
        ↓
Shows QR code (valid 10 minutes)
        ↓
Receptionist scans with any phone camera
        ↓
Phone opens a capture page (no login needed)
  - "Guest photo"  "ID front"  "ID back"  "+ extra page"
        ↓
Phone captures → crops → compresses → uploads
        ↓
Desk screen updates live: ✓ ID front received
        ↓
Receptionist taps DONE on desk; QR session closes
```

Security rules for the capture session:

- QR contains a random, single-use session token (not a guest ID)
- Token valid for 10 minutes and for **one** check-in draft only
- The phone page can **only upload** into that draft; it cannot view
  guest details, other documents, or any other data
- Session ends when the desk taps Done, the draft is confirmed, or the
  token expires
- Desk receives updates through Server-Sent Events or WebSocket, with
  polling fallback
- Every session is audit-logged (created by, device, files received)

## 19.3 Camera behaviour

- Camera APIs require **HTTPS**; all environments including staging use
  HTTPS
- Primary method on phones: `<input type="file" accept="image/*"
  capture="environment">` (opens the native camera; most reliable on
  iPhone and Android)
- Live preview (`getUserMedia`) for desk webcam and guest photo, with the
  native input as fallback
- Clear message if camera permission is denied, with steps for that
  browser
- Front/back camera switch where available
- Test matrix: iPhone Safari, Android Chrome (including a budget phone),
  Windows Chrome with USB webcam, macOS Safari/Chrome

## 19.4 Document processing on the device (no AI)

1. **Edge detection** with OpenCV.js or jscanify (classical computer
   vision), loaded only when the capture screen opens
2. Auto-crop with **perspective correction**
3. **Manual corner adjustment** always available if detection fails
4. **Quality check**: blur score (Laplacian variance) and brightness;
   show "Photo looks blurry — retake?" (owner setting: warn or block)
5. *(Removed by the product owner, 18 Sep 2026.)* On-device Aadhaar
   masking was built and then removed after real-device testing: it put an
   extra screen, a drag-to-position box and a confirmation tick-box in front
   of the receptionist. **Every ID is now captured and stored the same way** —
   Aadhaar exactly like a driving licence or a passport. What protects the
   images instead: private encrypted storage, 60-second signed URLs, and a
   logged access trail (section 19.7). See migration `0008` and CLAUDE.md
   rule 11.
6. **Re-encode** to JPEG or WebP: longest side max 2000 px, quality ~0.8,
   target under 600 KB; this also removes EXIF metadata (location)
7. Handle iPhone HEIC: prefer the browser's JPEG conversion; server
   converts any HEIC that still arrives

## 19.5 Upload reliability

```text
Processed image
  ↓ compute SHA-256 on device
  ↓ save to IndexedDB upload queue (survives refresh / bad Wi-Fi)
  ↓ request pre-signed upload URL from API
  ↓ upload directly to private object storage
  ↓ API confirms: object exists, size and checksum match
  ↓ guest_documents row: PENDING → VERIFIED
  ↓ remove from device queue
```

- Automatic retry with backoff; resumes when connection returns
- Uploads never block the rest of the form
- Documents uploaded but never attached to a confirmed check-in are
  flagged after 7 days for owner review — never silently deleted

## 19.6 Rules at confirmation

- Required documents (by property setting) must be **VERIFIED** on the
  server before check-in can be confirmed
- "Uploading…" or "Failed" documents block confirmation with a clear
  message and a Retry button
- The draft is kept, so nothing typed is lost while waiting

## 19.7 Storage and access

- Private bucket, encrypted, versioned, replicated (section 52)
- Viewed only through short-lived signed URLs (for example 60 seconds)
- Receptionist can view documents of current stays; older documents are
  owner-only
- Every view is audit-logged
- Document metadata: type, stay, occupant, uploaded by, device, time,
  size, checksum, status

---

# 20. Guest Registration Card and Signature

- GRC generated at check-in: property, guest, occupants, stay dates,
  room, rate, meal plan, checkout time, house rules, ID requirement,
  privacy notice, consent checkboxes
- Signature options:
  - On the desk touchscreen or tablet
  - On the phone via the same QR capture session (signature page)
  - Print, sign on paper, scan with phone-as-scanner
- Signed GRC stored as a PDF with a SHA-256 hash recorded in the
  database; reprint and resend available

---

# 21. Room Shifting

```text
Room 204 → Room 307
Reason: AC not working
```

Backend:

- Validates the new room (exclusion constraint)
- Ends the old allocation on the shift date, starts a new one
- Rate: keep current rate, or apply new room type rate (Owner PIN if
  below floor)
- Old room → Dirty; new room → Occupied
- Folio stays the same; history keeps both rooms
- Audit-logged

---

# 22. Checkout Workflow

```text
1 Find stay (Today's departures / search / room)
2 Review bill — all charges, grouped by date
3 Add missing charges (food, activities, minibar, laundry, damages)
4 Settle — record payment(s), apply advance, deposit decision
5 Invoice — preview, finalize, print / WhatsApp / email
6 Confirm checkout
```

Checks before checkout:

- Balance must be zero, or moved to a company account (section 32), or
  owner-authorised as pending (Owner PIN, recorded as receivable)
- Security deposit decision recorded (section 27)
- Unposted charges warning

After checkout (one transaction):

```text
Stay        → Checked-out
Room        → Vacant · Dirty (housekeeping task created)
Folio       → Closed
Invoice     → Finalized
Audit       → Recorded
Outbox      → Thank-you + invoice message, Sheets sync
```

Late charges after checkout create a **supplementary invoice** or **debit
note**; the finalized invoice is never edited.

Early departure: charges recalculated for actual nights (rule
configurable), shown before confirmation.

---

# PART C — BILLING

# 23. Folio

Every stay (or group master bill) has a folio: the running bill.

```text
FOLIO F-2026-00123 · Room 204 · Rahul Sharma

16 Sep  Room – Deluxe (CP)          ₹4,000
16 Sep  Paneer Tikka × 2              ₹560
16 Sep  Advance – UPI (ref 4821)   −₹5,000
17 Sep  Room – Deluxe (CP)          ₹4,000
17 Sep  Jeep Safari × 2             ₹3,000
17 Sep  Laundry                       ₹300
                                  ─────────
Charges (before tax)               ₹11,860
Tax (estimated)                       ₹...
Paid                               −₹5,000
Balance                               ₹...
```

Folio line types:

- Room night (posted automatically at night audit)
- Food / beverage
- Activity
- Extra bed / extra person
- Early check-in / late checkout
- Laundry, transport, other
- Damage
- Discount
- Payment, advance, refund, deposit (shown separately from charges)

Every line stores: business date, type, name, quantity, rate, amount,
tax category, SAC, created by, created at, source (manual, night audit,
import).

Lines are never edited. A mistake is removed with a **void** (reason
required, rules in section 4.5) and re-added correctly. Voided lines stay
visible in history.

---

# 24. Food, Activity and Other Charges (No Restaurant System)

## 24.1 Add charge

```text
[ + ADD CHARGE ]

Type:      Food ▾   (Food · Beverage · Activity · Laundry · Transport · Other)
Item:      [ Paneer Tikka        ▾ ]   ← search saved items or type a new name
Quantity:  [ 2 ]
Rate:      [ ₹280 ]  (from saved item, editable)
Date:      Today (business date)
Note:      optional

Total ₹560 + tax
[ ADD TO BILL ]
```

- The **item name appears on the invoice line** exactly as entered
  (for example "Paneer Tikka × 2", "Jeep Safari × 2")
- Typing a new name is always allowed; owner can later save it as an item
- Quick-add buttons for the most-used items on the stay screen and the
  checkout screen
- Can be added from any stay screen, the room card on the dashboard, or
  at checkout

## 24.2 Saved charge items (owner settings)

Simple list, not a menu system:

- Name
- Type (Food, Beverage, Activity, Laundry, Transport, Other)
- Default rate
- Tax category (drives GST rate and SAC)
- Active / inactive

No kitchen tickets, no stock deduction, no menu categories, no
restaurant staff login.

## 24.3 Tax

Tax comes from the item's tax category and the dated tax settings
(section 30). The receptionist never picks a tax rate.

---

# 25. Payment Recording (No Payment Gateway)

ResortOS **records** payments. It does not process them. Card payments
happen on the resort's own POS machine; UPI through the resort's QR.

## 25.1 Methods

| Method | Reference captured |
|---|---|
| Cash | — |
| UPI (resort QR) | UTR / transaction ID (last digits allowed) |
| Card (POS machine) | Approval code and/or last 4 digits of card, POS terminal |
| Bank transfer | UTR / reference |
| Cheque | Cheque number, bank |
| Prepaid via OTA | OTA reference (section 33) |
| Company account | Company (section 32) |
| Guest credit | From earlier cancellation credit |

Owner setting: which references are required per method.

Never store full card numbers, CVV, or UPI PINs.

## 25.2 Payment record

- Payment number (for example `PAY-2026-000923`)
- Folio, guest, amount, method, reference
- Type: payment, advance, deposit, refund
- Business date, time, received by, shift
- Status: recorded / reversed

## 25.3 Split and partial payments

A bill can be settled with several payments (for example ₹5,000 cash +
₹8,913 card). Balance updates live.

## 25.4 Corrections

- Wrong entry: **reverse** (reason required) and record again
- Same business date: receptionist can reverse their own entry
- After night audit: owner only
- Reversals are separate records; nothing is overwritten

## 25.5 Receipts

Printable / WhatsApp receipt for advances and payments.

---

# 26. Advance Payments

```text
[ RECORD ADVANCE ]
Amount   ₹5,000
Method   UPI
Ref      4821
```

- Available on a reservation (before arrival) and at check-in
- Creates payment record + receipt voucher + folio credit + audit
- Carries from reservation to stay automatically
- GST treatment of advances is a configurable setting reviewed by the
  resort's CA

---

# 27. Security Deposits

- Separate from room revenue; not income, not taxed as a charge
- Recorded with method and reference (cash, UPI, or card on POS)
- At checkout, required decision:
  - Refund in full
  - Adjust against charges/damages (creates a folio payment line)
  - Part refund (Owner PIN)
- Damage charges need description and photos (phone capture)

---

# 28. Discounts and Rate Overrides

- Discount as percentage or amount, on a line or on the whole bill
- Reason required (short list + note)
- Receptionist limit enforced by backend (section 4.5); beyond it, Owner
  PIN
- Discount can push a room night into a different GST slab — tax
  recalculates immediately and the new tax is shown before saving
- All discounts appear in the staff activity report and owner review
  list

---

# 29. Invoices and GST

## 29.1 Invoice types

- **Tax Invoice** (GST-registered property)
- **Bill of Supply** (where applicable)
- **Credit note** (reduces a finalized invoice)
- **Debit note / supplementary invoice** (adds to a finalized invoice)
- **Receipt voucher** (advances)

## 29.2 Invoice contents

- Title (Tax Invoice / Bill of Supply)
- Resort legal name, address, GSTIN, state code, logo
- Invoice number and date
- Guest name, mobile (partly masked on printouts, setting), address
- For B2B: company legal name, GSTIN, billing address
- Place of supply (for accommodation: the property's location, so
  normally CGST + SGST)
- Stay dates, room(s)
- Lines: date, description (including food/activity item names), SAC,
  quantity, rate, taxable value, GST rate
- Tax summary by rate: taxable value, CGST, SGST (IGST where it genuinely
  applies)
- Round off (separate line)
- Total, payments received (by method), balance
- Bank / UPI details, terms, signature line
- "Computer generated invoice" note

## 29.3 Example

```text
                 XYZ RESORT
          GSTIN: 08XXXXXXXXXXXXX
                TAX INVOICE
Invoice: INV/26-27/00152     Date: 18/09/2026
Place of supply: Rajasthan (08)
Guest: Rahul Sharma

Date   Description            SAC     Qty   Rate   Taxable
16/09  Deluxe Room (CP)       996311   1   4,000    4,000.00
16/09  Paneer Tikka           996331   2     280      560.00
17/09  Deluxe Room (CP)       996311   1   4,000    4,000.00
17/09  Jeep Safari            (cfg)    2   1,500    3,000.00
17/09  Laundry                (cfg)    1     300      300.00
                                             ───────────────
Tax summary (illustrative — rates from settings)
 5% on ₹8,560.00     CGST 214.00   SGST 214.00
18% on ₹3,300.00     CGST 297.00   SGST 297.00
Round off                                         +0.00
TOTAL                                          ₹12,882.00
Paid: UPI ₹5,000.00 · Card ₹7,882.00
Balance                                             ₹0.00
```

The rates and SACs above are illustrative only. Activity and laundry
tax categories must be configured and confirmed by the resort's CA.

## 29.4 Invoice lifecycle

```text
DRAFT → FINALIZED → (credit note / debit note if needed)
```

Once finalized: lines, amounts, tax, number, date are immutable
(enforced by database trigger, not only by application code).

Invoice cancellation: owner only, reason required, implemented as a
full credit note.

---

# 30. GST Tax Engine

## 30.1 Dated tax settings

```text
tax_rules
  tax_category      accommodation | restaurant | activity | laundry | other
  condition         e.g. room value per room per night ≤ 7500.00
  rate              e.g. 5.00
  sac               e.g. 996311
  effective_from
  effective_to
```

The engine uses the rule valid on each line's date of supply. Finalized
invoices keep the rates they used forever.

## 30.2 Accommodation slab (as configured at launch)

Rates effective 22 September 2025 (confirm with CA before go-live):

- Room value up to ₹7,500 per room per night → 5%
- Above ₹7,500 per room per night → 18%

Engine rules:

- Evaluate per room, per night, on the actual charged value after
  discount
- Extra bed / extra person charges: whether they count toward the
  per-night value is a setting confirmed by the CA
- A discount or override that moves a night across the slab recalculates
  tax immediately

## 30.3 Food at the resort

The GST rate for food depends on the property's room tariffs. Store it
as a **property-level setting** reviewed by the CA. Never infer it
automatically.

## 30.4 E-invoicing

Setting to enable e-invoicing (IRN + signed QR) if the business crosses
the government turnover threshold. Disabled by default; integration via
a GST Suvidha Provider is a later phase.

## 30.5 Rounding

- All money in `NUMERIC(14,2)`, computed with exact decimal arithmetic
- Tax computed per tax-rate group, rounded to 2 decimals
- Invoice total rounded to nearest rupee, round-off shown as a line

## 30.6 Required tests

- ₹7,500.00 vs ₹7,500.01 per night
- Discount moves a night from 18% to 5%
- Mixed-rate invoice
- Rate change on an effective date in the middle of a stay
- Credit note totals equal original
- Rounding edge cases (x.50)

---

# 31. Invoice Numbering

GST requires unique, consecutive numbers per series, restarting each
financial year, maximum 16 characters.

**Do not use PostgreSQL SEQUENCE** for invoice numbers — sequences skip
numbers when a transaction rolls back.

Use a counter table:

```sql
CREATE TABLE document_counters (
  property_id     uuid,
  series          text,     -- 'INV', 'CN', 'DN', 'RV'
  financial_year  text,     -- '26-27'
  last_number     integer NOT NULL,
  PRIMARY KEY (property_id, series, financial_year)
);

-- inside the finalize transaction:
UPDATE document_counters
SET last_number = last_number + 1
WHERE property_id = $1 AND series = 'INV' AND financial_year = $2
RETURNING last_number;
```

The row lock serialises finalization; a rollback releases the number
unused. Format example: `INV/26-27/00152` (15 characters). Unique
constraint on (property, full number). Numbers are assigned only at
finalization, never to drafts.

---

# 32. Company Billing

- Company accounts: name, GSTIN, billing address, contact person, phone,
  email, credit limit, payment terms (days)
- At checkout, move the balance or selected lines to the company account
- Invoice issued in company name and GSTIN
- Company statement, outstanding, ageing (0–30, 31–60, 61–90, 90+ days)
- Record company payments against invoices
- Warning when credit limit is exceeded (Owner PIN to proceed)

---

# 33. OTA Bookings

ResortOS tracks OTA bookings; it does not connect to OTAs in v4.

- OTA name, OTA booking reference (unique per OTA — duplicates rejected)
- Payment mode: **Prepaid to OTA** or **Pay at resort**
- Commission (percentage or amount), taxes deducted by OTA (fields,
  amounts as per CA)
- Expected payout, received payout, date, difference
- The guest invoice shows the correct room value even when the OTA
  collected payment
- OTA receivables report: booked, expected, received, pending,
  difference

> Operational note: without a channel manager, the resort must update
> OTA extranets manually after walk-ins and direct bookings, which can
> cause overbooking outside ResortOS. Show an **"Availability changed
> today"** list on the dashboard to remind staff which dates/room types to
> update on OTAs. Channel manager integration is a later phase
> (section 82).

---

# 34. Cashier Shifts and Owner Review

## 34.1 Open shift

Receptionist opens a shift with opening cash count.

## 34.2 During shift

Every payment, refund, and cash expense is tied to the open shift.

## 34.3 Close shift

```text
SHIFT CLOSE · Receptionist 01 · 16 Sep, 8:00 AM – 8:00 PM

             Expected    Actual     Difference
Cash         ₹41,000     ₹40,500    −₹500   (reason required)
UPI          ₹62,000     —
Card (POS)   ₹25,000     POS batch total ₹25,000  ✓

Handover note: Room 107 guest arriving late, key at desk.
[ CLOSE SHIFT ]
```

- Card total compared with the POS machine's settlement slip total
  (entered by receptionist)
- Cash difference above threshold requires a reason
- Closed shift is locked; printable shift report

## 34.4 Owner review list (rule-based, no AI)

A simple list on the owner dashboard showing items worth a look:

- Owner PIN overrides used today (who, what, amount)
- Discounts above X%
- Voided charge lines and reversed payments
- Cash differences above threshold
- Invoices corrected by credit note
- Checkouts with pending balance
- Rooms marked occupied with no stay (data mismatch)

Each item links to the record. Owner marks items **Seen**. Rules and
thresholds are configurable and unit-tested.

---

# 35. Night Audit and Business Date

The property runs on a **business date**, which moves forward only
through night audit.

## 35.1 Steps

```text
NIGHT AUDIT · Business date 16 Sep 2026

1 Arrivals not checked in       → No-show / Extend / Cancel (each one)
2 Departures not checked out    → Check out / Extend stay
3 Open cashier shifts           → must be closed
4 Room charges                  → post tonight's room nights for all
                                  occupied rooms (idempotent)
5 Room status check             → occupied rooms without stay, etc.
6 Summary                       → revenue, payments by method, occupancy
[ COMPLETE NIGHT AUDIT ]
```

## 35.2 Rules

- Room nights posted once per room per business date (unique constraint:
  folio + room + business date + type)
- After completion: business date +1; transactions for the closed date
  are locked (corrections happen on the current date)
- Owner setting: who can run night audit; optional auto-reminder at a set
  time
- If not run by a set time, dashboard banner and owner notification
- Completion triggers (via outbox): owner daily summary, Google Sheets
  daily summary, Revenue Intelligence metric refresh, backup-verification
  check

---

# 36. Printing

- A4 invoice, receipt, GRC, shift report, police register
- 80 mm thermal receipt format (optional)
- Browser print with print-specific CSS; PDF generated server-side for
  WhatsApp/email and archive
- Printouts mask guest mobile partly (setting)

---

# PART D — OPERATIONS

# 37. Housekeeping

- Board: Dirty · Cleaning · Clean · Inspected, filterable by floor/block
- Task created automatically on checkout; stayover cleaning tasks daily
  (setting)
- Task: room, type, assigned to, priority, created, started, completed,
  completed by, note, photos (optional)
- Receptionist/owner can update status directly if cleaner mode is off
- Optional cleaner mode (section 4.3) with WhatsApp task notification
- Room status updates live on all screens

---

# 38. Maintenance

- Ticket: room or area, issue, description, photos, priority, assigned
  to, status, created, resolved, cost, resolution note
- Statuses: Open → In progress → Resolved → Closed
- Option to mark room **Maintenance** or **Out of order** from the
  ticket (removes it from sellable inventory with date range)
- Preventive schedules (AC service, generator, pump, water tank, fire
  extinguishers) create tickets on due dates

---

# 39. Expenses

- Date, category, amount, payment method, paid to (free text or vendor
  name), note, bill photo (phone capture)
- Categories configurable (electricity, salaries, groceries, repairs,
  diesel, marketing, other)
- Cash expenses reduce shift expected cash
- Edit same day with audit; after night audit, owner only, via
  correction entry
- Monthly expense report; included in Sheets mirror and Drive archive

---

# PART E — COMMUNICATION

# 40. Guest Messages

Channels: **WhatsApp** (primary), **email**. SMS optional, disabled by
default.

| Trigger | Message |
|---|---|
| Booking confirmed | Booking details, dates, advance received |
| Check-in completed | Welcome, room, checkout time, Wi-Fi, reception number, location link |
| Evening before checkout (e.g. 7 PM) | Checkout reminder, late checkout contact |
| Checkout completed | Thank you + invoice PDF |
| Payment/advance recorded | Receipt |

Rules:

- Checkout reminder skipped for one-night stays checked in the same
  afternoon (configurable)
- Quiet hours (default 9:30 PM – 8:00 AM) for non-urgent messages
- Each message: template, channel, recipient, status (queued, sent,
  delivered, read, failed), retries, failure reason
- Failed WhatsApp → email fallback if available
- "Resend" button on the stay
- Message failure never affects the booking or bill

Template variables:

```text
{{guest_name}} {{resort_name}} {{room_number}} {{check_in_date}}
{{check_out_date}} {{checkout_time}} {{balance}} {{invoice_number}}
{{reception_phone}} {{location_link}}
```

English and Hindi versions of each template.

---

# 41. Messaging Compliance

## WhatsApp

- Business-initiated messages use Meta-approved templates only
  (utility category for booking, check-in, reminder, invoice)
- Record guest opt-in; marketing messages only with separate marketing
  consent
- Template approval status shown in settings

## Email

- Verified sending domain (SPF, DKIM, DMARC)

## SMS (only if enabled)

- DLT registration (entity, sender header, templates, whitelisted links)
  must be complete before enabling
- DLT template ID stored per template

## Never send

- ID numbers or ID images
- Card details
- Passwords, PINs

---

# 42. Owner Daily Summary

Sent after night audit, by WhatsApp and/or email, to owner accounts.

```text
XYZ Resort · Wed 16 Sep

Occupancy      78%  (14 of 18 rooms)
Room revenue   ₹1,12,000
Food           ₹18,400
Activities     ₹20,000
Collected      ₹1,31,000
  Cash ₹22,000 · UPI ₹84,000 · Card ₹25,000
Pending dues   ₹32,500
Cash difference −₹500
Needs a look   3 items
Tomorrow       9 arrivals · 6 departures

Data safety    ✓ Backed up · ✓ Sheets synced
```

Template-based (no AI). Recipients, time, and lines configurable.

---

# PART F — EASY DATA ACCESS FOR NON-TECHNICAL OWNERS

Owners are not technical. They must be able to see their data in places
they already understand, without ever touching a database. There are
four layers, from simplest to most complete:

```text
1. Records area in the app        (search, view, one-tap Excel/PDF)
2. Google Sheets mirror            (live read-only copy in their Google account)
3. Google Drive monthly archive    (invoices PDFs + Excel, forever in their Drive)
4. Full data export                (everything, on request)
```

None of these is the source of truth. PostgreSQL is. None of these
replaces backups (Part G).

# 43. Records Area (in the App)

Owner-only screen written in plain language:

```text
RECORDS

📅 Bookings        🧾 Bills & invoices     💰 Payments
👤 Guests          🧹 Expenses              📊 Daily summaries
🌍 Form C          👮 Police register       📁 Monthly archives
```

- Pick a date range with presets: Today, Yesterday, This week, This
  month, Last month, This financial year
- Simple table with search
- Every table has **Download Excel** and **Download PDF**
- Tap any row to open the full record
- "Open in Google Sheets" and "Open Drive folder" buttons
- Every download is audit-logged
- Works well on the owner's phone

---

# 44. Google Sheets Mirror

## 44.1 Purpose

A **read-only, automatically updated copy** of key business data in a
Google Sheet the owner can open on their phone or computer.

## 44.2 Setup (owner, one time)

```text
Settings → Google
[ CONNECT GOOGLE ACCOUNT ]
     ↓
Owner signs in with Google and allows ResortOS to create and update
files it creates (least-privilege scope)
     ↓
ResortOS creates "XYZ Resort – ResortOS Data FY 2026-27"
     ↓
✓ Connected · Last synced 2 minutes ago
```

- Use the narrowest Google scope that allows creating and editing only
  files ResortOS created
- OAuth refresh token stored encrypted
- If access is revoked, show a clear banner and email the owner

## 44.3 Spreadsheet structure

One spreadsheet per financial year (avoids Google Sheets size limits):

| Tab | One row per |
|---|---|
| Daily Summary | Business date: occupancy, room revenue, food, activities, collections by method, dues, cash difference |
| Bookings | Reservation: number, guest first name + last initial, source, dates, nights, rooms, status, total |
| Bills | Invoice: number, date, taxable, CGST, SGST, total, paid, balance |
| Bill Lines | Invoice line: invoice, date, item name, type, qty, rate, amount |
| Payments | Payment: number, date, method, amount, reference (last 4 only), received by |
| Expenses | Expense: date, category, amount, method, note |
| OTA | Booking: OTA, reference, expected payout, received, pending |
| Read Me | What each tab means; "Do not edit — changes are overwritten" |

## 44.4 Privacy rules for the Sheet (DPDP)

Never send to Google Sheets:

- ID numbers, ID images, guest photos, signatures
- Full mobile numbers (show last 4 only), email addresses, home
  addresses
- Form C / passport / visa data
- Internal notes and guest flags

Owner can switch off individual tabs.

## 44.5 Sync mechanics

- One-way only: ResortOS → Sheet. **Never read data back.**
- Triggered by outbox events (payment, invoice, checkout, expense) and
  batched every 2–5 minutes
- Upsert by stable key (booking number, invoice number, payment number)
  so retries never create duplicate rows
- Uses batch update calls and respects Google API quotas with backoff
- **Nightly full rebuild** of the current month's rows after night audit,
  so any manual edits or partial failures are corrected
- Sheet tabs are protected (owner warning when trying to edit)
- Sync status visible in the Data Safety panel: last success, pending
  rows, last error in plain language
- Sync failure never affects the app

---

# 45. Google Drive Monthly Archive

On the 2nd of each month (after night audit), ResortOS writes to a
folder in the owner's Google Drive:

```text
ResortOS – XYZ Resort/
  FY 2026-27/
    2026-09 September/
      Invoices/            INV-26-27-00152.pdf …
      Credit notes/
      Monthly report.pdf   (occupancy, revenue, payments, expenses, GST summary)
      Bookings.xlsx
      Bills.xlsx
      Payments.xlsx
      Expenses.xlsx
      GST summary.xlsx
```

- Invoice PDFs are tax documents the owner must keep; guest mobile is
  partly masked
- **No ID documents, photos, or Form C data** in Drive
- File checksums recorded in ResortOS; the archive job verifies each
  upload
- Owner can trigger "Create archive now" for any past month
- Status shown in the Data Safety panel

---

# 46. Exports

Owner-only (receptionist limited to operational exports if allowed):

- Excel (.xlsx) and CSV for every report
- PDF for invoices, reports, police register
- **Tally**: vouchers export (sales, receipts) in a Tally-importable format
  agreed with the resort's accountant
- **GSTR-1-ready** export: B2B, B2C, credit/debit notes, SAC summary,
  documents issued
- **Full data export** (owner, re-authentication required): all records
  as Excel/CSV plus all documents in a ZIP — so the resort always owns
  and can take its data

Every export logs: user, time, report, filters, row count.

---

# PART G — DATA SAFETY (NON-NEGOTIABLE)

# 47. Reality and Targets

No system can honestly guarantee literal zero data loss. ResortOS uses
independent layers so that no single failure — a bug, a bad deploy, a
deleted table, a cloud account problem, or a region outage — loses
business data.

| Target | Value |
|---|---|
| Maximum data loss on database failure (RPO) | ≤ 5 minutes |
| Time to restore service (RTO) | ≤ 60 minutes for database; ≤ 4 hours for full provider-loss scenario |
| Backup copies | At least 3, in 2 different providers, 2 different regions |
| Restore verification | Automated weekly; manual drill quarterly |

---

# 48. Database Integrity

- Primary keys, foreign keys, NOT NULL, CHECK, UNIQUE, and EXCLUSION
  constraints for every business rule that can be expressed in the
  database
- `ON DELETE RESTRICT` on all financial and stay relationships; no
  cascading deletes on critical data
- No hard `DELETE` on: reservations, stays, folios, folio lines,
  payments, invoices, credit/debit notes, shifts, audit logs, documents,
  Form C records. Use status fields (`cancelled`, `voided`, `reversed`,
  `archived`)
- Database triggers block UPDATE/DELETE on finalized invoices, closed
  shifts, posted folio lines, and audit logs
- The application database user has **no permission** to DROP or
  TRUNCATE tables; migrations run with a separate migration user
- Every migration: reviewed, tested on a copy of production data in
  staging, reversible or with a documented rollback, run only after a
  fresh backup
- Timestamps stored as `timestamptz`; business dates stored as `date`

---

# 49. Money

- `NUMERIC(14,2)` in PostgreSQL; decimal library in TypeScript (never
  JavaScript floating-point numbers for money)
- Amounts exchanged in the API as strings
- Folio balance is always recalculated from lines, never stored as the
  only copy; a stored cached balance is checked against the calculation
  by the integrity job

---

# 50. Audit Log

- Append-only table; application user can INSERT only
- Each entry: id, timestamp, user, authorised-by (Owner PIN), device,
  session, IP, action, entity type, entity id, before values, after
  values, reason, request id
- **Tamper-evident**: each entry stores a SHA-256 hash of its content
  plus the previous entry's hash (hash chain); a daily job verifies the
  chain and alerts the owner if broken
- Daily chain head hash also written to backup storage in the second
  provider
- Audit viewer for owner with filters and plain-language descriptions
  ("Receptionist 01 gave a 15% discount on Room 204, authorised by Owner")

---

# 51. Idempotency and Concurrency

Idempotency key required on: create booking, check-in, checkout, add
charge, record payment, refund, reverse, finalize invoice, close shift,
night audit, imports.

```text
Same key again → return the original result, do nothing new
```

Concurrency:

- Row locks on folio when adding charges, payments, or finalizing
- Checkout locks the folio; a charge added at the same moment either
  lands before the lock or is rejected with "Bill is being finalized"
- Optimistic version column on editable records (guest profile,
  reservation); stale edits get "This was changed by someone else —
  reload"

Required tests: two users book the same room; double-click payment;
double checkout; charge during checkout; two night audits at once;
simultaneous invoice finalization.

---

# 52. File Storage Durability

Applies to guest photos, ID documents, GRC PDFs, invoice PDFs, expense
bills, maintenance photos.

- Private bucket, encryption at rest, public access blocked
- **Versioning ON** (overwrites and deletes keep previous versions)
- **Replication** to a bucket in a second India region
- **Nightly copy** to the second provider (section 53.3)
- Object Lock / immutable retention on backup copies
- Every file referenced by a database row with size and SHA-256; weekly
  job samples files and verifies checksums
- Lifecycle rules only for documents past the configured retention
  (section 59), never for invoices within the legal retention period

---

# 53. Backups and Disaster Recovery

## 53.1 Layer 1 — Managed primary

- Managed PostgreSQL in **AWS Mumbai (ap-south-1)** (or equivalent India
  region)
- Multi-AZ standby (automatic failover)
- Automated backups with **point-in-time recovery**, maximum retention
  the service allows (for example 35 days)
- Encrypted storage

## 53.2 Layer 2 — Second region, same provider

- Automated backups and snapshots copied to **AWS Hyderabad
  (ap-south-2)**
- Object storage replicated to Hyderabad

## 53.3 Layer 3 — Different provider

Protects against account suspension, billing problems, compromised
credentials, or provider-wide issues.

- Nightly logical backup (`pg_dump` custom format) after night audit
- Encrypted with a key held **outside** the primary cloud account
  (section 54)
- Uploaded to a different provider's object storage (for example
  Backblaze B2, Google Cloud Storage, or Cloudflare R2) with Object Lock
  (immutable, cannot be deleted before retention ends)
- Nightly copy of new/changed files from object storage
- Written with credentials that can **write but not delete**

## 53.4 Retention

| Backup | Keep |
|---|---|
| Point-in-time recovery | 35 days |
| Daily logical backups | 60 days |
| Weekly | 6 months |
| Monthly | 8 years (financial record retention; confirm with CA) |

## 53.5 Restore testing

Automated weekly:

```text
Take latest Layer 3 backup
  ↓ restore into isolated database
  ↓ run integrity checks (section 55)
  ↓ compare row counts and financial totals with production snapshot
  ↓ run API smoke tests against it
  ↓ record PASS / FAIL, alert on FAIL
  ↓ destroy the test database
```

Quarterly manual drill: full restore of database + files from Layer 3
into a new environment, timed, documented.

## 53.6 Disaster recovery runbook

Written, tested procedures for:

- Accidental data change → point-in-time restore to a side database,
  copy back the affected records
- Primary database failure → failover / restore
- Region outage → restore in Hyderabad
- Cloud account lost or compromised → restore from Layer 3 into a new
  account
- Bad deployment → roll back application; restore data if needed
- Lost encryption key → section 54 recovery

## 53.7 Data Safety panel (owner, plain language)

```text
DATA SAFETY

✅ Your data is safe
   Last backup            Today, 2:14 AM
   Copies                 3 locations (Mumbai, Hyderabad, off-site)
   Last restore test      Sunday — passed
   Google Sheets          Synced 3 minutes ago
   Drive archive          September archive complete
   Messages               All delivered (2 retried)

⚠️ Shown in amber/red with a simple explanation and what to do,
   e.g. "Google access expired — tap to reconnect"
```

Technical details (WAL lag, job IDs) visible only in the admin/ops view.

## 53.8 Backup safety rules

- Application credentials cannot delete backups, disable versioning,
  change Object Lock, or change retention
- Backup credentials are separate and stored in a secrets manager
- Alerts to the operator (and owner summary) on: missing backup, failed
  backup, unusual size change, failed restore test, replication lag,
  broken audit chain

---

# 54. Encryption Key Management

An encrypted backup without its key is lost data.

- Cloud KMS keys for database and storage encryption (primary provider)
- Layer 3 backup encryption key (for example `age` key pair):
  - Public key on the backup worker (can encrypt, cannot decrypt)
  - Private key stored in two places outside the primary cloud: a
    password manager vault of the operator and an offline sealed copy
    kept by the business owner
- Key rotation procedure documented; old keys kept until all backups
  encrypted with them expire
- Quarterly drill includes decrypting with the stored key

---

# 55. Integrity Monitoring

Nightly job (after night audit) checks:

- Folio balance = sum of lines
- Invoice totals = sum of invoice lines + tax
- No gaps or duplicates in invoice numbers per series and year
- No overlapping allocations (should be impossible; verifies constraint)
- Every checked-in stay has an occupied room and vice versa
- Every payment belongs to a folio and a shift
- Every critical action has an audit entry
- Audit hash chain valid
- Every document row has a file, and every VERIFIED file exists
- Sheets sync and Drive archive completed

Findings are **never auto-repaired**. They create an incident record and
appear in the Data Safety panel and operator alerts.

---

# 56. Offline and Poor Internet

No two-way offline sync.

Allowed while offline:

- View cached today's arrivals, departures, room status (read-only)
- Continue a check-in draft on the device; photos wait in the upload
  queue
- Printable fallback sheet (arrivals, departures, in-house guests) —
  printed automatically each morning if a printer is configured

Not allowed offline: confirm check-in, checkout, payments, invoices,
room allocation, night audit.

Banner: **"Offline — nothing new is saved until the internet is back."**

Recommendation to resorts: a backup 4G router at the front desk.

---

# PART H — SECURITY AND COMPLIANCE

# 57. Security Controls

- HTTPS everywhere, HSTS
- Argon2id passwords, rate limiting, account lockout
- Secure cookies, CSRF protection, strict Content Security Policy
- Backend authorization on every endpoint (role + limit checks)
- Input validation on every request
- Parameterised queries only
- Row-level `property_id` scoping on every query; PostgreSQL Row-Level
  Security as a second guard when more than one resort uses the system
- Private storage, signed short-lived URLs
- Secrets in a secrets manager; nothing in code or logs
- Personal data never written to logs (mask mobile, no ID numbers)
- Dependency scanning and automatic security updates in CI
- OWASP ASVS Level 2 as the verification baseline
- **External VAPT** (vulnerability assessment and penetration test)
  before first production launch and yearly after
- Security incident response procedure, including DPDP breach
  notification steps

---

# 58. India Compliance

## 58.1 Form C (foreign guests)

Accommodation providers must report foreign nationals to the Bureau of
Immigration / FRRO within 24 hours of arrival.

When any occupant's nationality is not Indian:

- Required fields: passport number, place and date of issue, expiry;
  visa number, type, place and date of issue, expiry; date and port of
  arrival in India; arrival at resort; expected departure; next
  destination; addresses and contact in India and home country
- Passport and visa page images (phone-as-scanner)
- `form_c_records` status: Pending → Submitted (reference number) →
  Departure updated
- Dashboard reminder with countdown while pending
- Ready-to-copy summary for the official portal; no assumption of an
  official API
- Confirm current official process before go-live

## 58.2 Police / guest register

- Export per date range, one row per occupant
- Columns configurable to match the local police station's format
- PDF and Excel; every export audit-logged

## 58.3 Identity documents

**No ID type is treated specially.** Aadhaar, driving licence, passport,
voter ID and PAN all follow one path: photograph, crop, store.

- ID images are stored as captured, in private encrypted storage, and are
  opened only through 60-second signed URLs with every view logged
  (section 19.7)
- An ID *reference* is recorded against the occupant alongside the image
- On-device masking was removed by the product owner on 18 Sep 2026 after
  real-device testing (migration `0008`)

## 58.4 DPDP Act

- Privacy notice at check-in (on GRC and screen), English and Hindi
- Separate consents: (1) stay and legal compliance, (2) marketing
  (optional, unticked by default)
- Consent records: what, when, notice version, method
- Data requests from guests (access, correction, erasure) recorded
  with status and completion date
- Erasure never deletes legally required records (invoices, Form C,
  police register); anonymise other personal data where allowed
- Data minimisation in Google Sheets/Drive (section 44.4)
- Breach response procedure
- Data processing agreement between ResortOS (as data processor) and
  each resort (section 84)
- Legal review of the configuration before production

---

# 59. Data Retention

Configurable per category, with safe defaults reviewed by the resort's
CA/legal adviser:

| Data | Default |
|---|---|
| Invoices, credit notes, payments, ledgers | 8 years |
| Form C, police register records | As legally required |
| Guest ID images | Configurable period after checkout, then deleted (record of deletion kept) |
| Guest photos | Same as ID images |
| Audit logs | 8 years |
| Message delivery logs | 1 year |
| Upload queue orphans | Owner review after 7 days |

Deletion jobs run only on data past retention, log each deletion, and
never touch financial records inside retention.

---

# 60. Guest Flags

- **VIP** — shown at check-in and on the room card
- **Special note** — for example "anniversary, arrange cake"
- **Do not rent** — owner only, mandatory factual reason (for example
  "unpaid balance ₹8,000 from BK-000812"), audit-logged, reviewable
- No discriminatory or irrelevant personal labels
- Flags never sent to Google Sheets, Drive, or messages

---

# PART I — AI REVENUE INTELLIGENCE (THE ONLY AI FEATURE)

# 61. Overview

**Purpose:** help the owner understand revenue performance in plain
language — what happened, why it likely happened, and what may come
next.

**Looks at:** occupancy, ADR, RevPAR, room revenue, food charges, OTA
commissions, net revenue, discounts, cancellation trends, length of
stay, booking lead time.

**Provides:** insights, trends, explanations, forecasts.

**Advisory only.** It cannot change prices, bookings, payments, refunds,
invoices, or any other record.

## 61.1 "Only if easy" rule

The feature is split into layers. Layers 1–2 are required and contain no
AI. Layers 3–4 are built only in the simple form described here.

```text
Layer 1  Metrics (SQL, deterministic)            REQUIRED
Layer 2  Revenue dashboard + reports             REQUIRED
Layer 3  Forecast (simple statistics, no ML)     Build if acceptance criteria met
Layer 4  AI explanations (LLM narrates numbers)  Build if acceptance criteria met
```

No model training, no separate Python service, no GPU, no vector
database. If layer 3 or 4 does not meet the acceptance criteria in
section 66, it stays switched off and the product is still complete.

---

# 62. Metric Definitions (Layer 1)

All revenue figures **exclude GST**. All figures are attributed to the
business date of the charge (room night date), not the payment date.

| Metric | Definition |
|---|---|
| Available room-nights | Active rooms × days − out-of-order room-nights |
| Sold room-nights | Room-night charges posted (complimentary nights counted separately) |
| Occupancy % | Sold ÷ Available × 100 |
| Room revenue | Room-night charges after discounts |
| ADR | Room revenue ÷ Sold room-nights |
| RevPAR | Room revenue ÷ Available room-nights |
| Food charges | Food + beverage lines after discounts |
| Activity & other revenue | Activity, laundry, transport, other lines after discounts |
| Total revenue | Room + food + activity & other |
| OTA commission | Commission on stays in the period (by stay dates) |
| Net revenue | Total revenue − OTA commission |
| Discounts | Sum of discount amounts (by type and by user) |
| Cancellation rate | Cancelled bookings ÷ bookings whose original arrival is in the period |
| No-show rate | No-shows ÷ bookings whose arrival is in the period |
| Average length of stay | Total nights ÷ number of stays checked out in the period |
| Booking lead time | Arrival date − booking created date (average and median; walk-ins = 0) |
| On the books (OTB) | Confirmed room-nights and room revenue for future dates, as of today |

Breakdowns: by day, week, month, day of week, room type, booking source,
meal plan.

Storage:

- `daily_metrics` table filled at night audit for the closed business
  date
- Recomputed automatically if a correction touches a past date
- `otb_snapshots` table: each night, store OTB for the next 90 days
  (needed for forecasting and pickup)
- Metric formulas implemented once in SQL views/functions with unit
  tests on fixed datasets

---

# 63. Revenue Dashboard (Layer 2, no AI)

Owner-only.

```text
REVENUE · September 2026            [This month ▾]  vs [Last month ▾]

Occupancy   72%   ▲ 6 pts      ADR    ₹4,850  ▲ 3%
RevPAR    ₹3,492  ▲ 12%        Net revenue ₹14.6L ▲ 9%

[Chart: occupancy & ADR by day]
[Chart: revenue mix — room / food / activities]
[Chart: booking source share + OTA commission]
[Chart: discounts by week]
[Chart: cancellations by source]
[Chart: length of stay & lead time distribution]
[Chart: on the books — next 30 / 60 / 90 days]
```

- Compare with previous period and same period last year (when data
  exists)
- Tap any chart to see the underlying records
- Download Excel/PDF
- Works on phone

---

# 64. Forecast and AI Explanations (Layers 3–4)

## 64.1 Forecast (Layer 3 — simple statistics, no ML)

For each future date in the next 30 and 60 days, per property:

```text
Forecast room-nights = On the books today
                     + expected pickup
```

Expected pickup = average of the room-nights that were added between
"N days before arrival" and arrival, for comparable past dates (same
day-of-week, recent 12 weeks; same month last year when available).

- Room revenue forecast = forecast room-nights × recent ADR for that
  day-of-week
- Show a **range** (low–high from the spread of past pickups), never a
  single "exact" number
- Show "Based on N days of history"
- Track accuracy: after each date passes, store forecast vs actual; show
  "Last month's forecasts were within ±X%"
- Pure TypeScript/SQL; unit tests with fixed datasets
- Hidden until at least 90 days of history exist (imported history
  counts)

## 64.2 AI explanations (Layer 4 — LLM narrates computed numbers)

The AI **never calculates**. The backend calculates everything (layers
1–3). The LLM only turns those numbers into short, plain-language
explanations.

Flow:

```text
Weekly (after Monday night audit) or owner taps "Refresh" (max 5/day)
  ↓
Backend builds an aggregated JSON "facts pack":
  - period metrics, previous period, same period last year
  - breakdowns by source, room type, day of week
  - discounts, cancellations, lead time, length of stay
  - forecast with ranges and accuracy
  - data coverage (days of history, missing days)
  NO guest names, phones, IDs, invoice numbers, staff names
  ↓
LLM API call (server-side key, timeout 30 s)
  ↓
Response must match a strict JSON schema
  ↓
Validation (section 64.3)
  ↓
Store insight + facts pack hash + model + prompt version
  ↓
Show on Revenue dashboard and owner home
```

Required output schema:

```json
{
  "summary": "2–3 sentence overview",
  "insights": [
    {
      "type": "trend | explanation | opportunity | watch | forecast",
      "title": "short title",
      "explanation": "1–3 sentences using only provided numbers",
      "metrics_used": ["occupancy.weekend", "occupancy.weekday"],
      "period": "Last 90 days"
    }
  ],
  "questions_for_owner": ["optional short questions"]
}
```

Maximum 5 insights. English or Hindi (owner setting).

System prompt rules (versioned in code):

- Use only numbers present in the facts pack
- Say "the data suggests", never "guaranteed" or "will definitely"
- Do not recommend exact prices; suggest what to review
- If data coverage is low, say so
- No mention of individual guests or staff

## 64.3 Validation (why this is safe and easy)

Before any insight is shown:

1. JSON schema valid
2. Every `metrics_used` key exists in the facts pack
3. **Every number in the text matches a number in the facts pack**
   (allowing display rounding, e.g. 91.4% shown as 91%)
4. No banned phrases (guaranteed, certainly, will increase by …)
5. Length limits

Failed insights are dropped. If the whole response fails twice, the
dashboard shows metrics and forecast only, with "Explanations are not
available right now."

## 64.4 Example

```text
✨ AI summary · Last 90 days
Weekends are nearly full while weekdays are half empty. Room revenue
grew mainly from higher weekend rates, not more guests.

TREND
Weekend occupancy 91% vs weekday 57% over the last 90 days.

EXPLANATION
ADR rose 8% while occupancy stayed at 72%, so revenue growth came from
rate, not volume.

WATCH
Booking.com cancellations were 18% of its bookings vs 6% for direct
bookings.

FORECAST
Next 30 days: 64–71% occupancy expected (on the books today: 52%).
Last month's forecasts were within ±6%.

OPPORTUNITY
Review weekday packages; weekdays have the most unsold rooms.

Generated from ResortOS data on 14 Sep · AI can be wrong — check before
acting.
```

---

# 65. AI Safety and Isolation

- Revenue Intelligence module reads only aggregated metric tables/views
  through a **read-only database role**
- It has no write access to any business table; it can only insert into
  `revenue_insights`
- No personal data leaves ResortOS for the AI provider
- Provider behind an `LlmProvider` interface; API key in secrets manager
- Monthly cost cap and per-day call limit; stops cleanly when reached
- Owner setting: **AI explanations ON / OFF** (kill switch)
- AI failure, timeout, or provider outage never affects any other screen,
  job, or night audit
- Label every AI text as AI-generated with its date and data period
- Every insight stored with inputs hash, model, prompt version — so any
  insight can be explained later

---

# 66. Acceptance Criteria and Activation

**Forecast (Layer 3) ships only if:**

- Unit tests pass on at least 10 fixed historical datasets
- Back-test on available history shows ranges contain actuals for most
  days (target ≥ 70%)
- 90+ days of history available at the property

**AI explanations (Layer 4) ship only if:**

- Validation (section 64.3) implemented and tested
- 20 fixed test facts packs produce valid output, with zero unvalidated
  numbers shown
- Estimated build effort stays within about two weeks after Layer 2 is
  complete
- Owner has switched it on

Otherwise the feature flag stays off. No other part of ResortOS depends
on it.

---

# PART J — UI / UX

# 67. Design Principles

1. **Speed first.** A returning-guest check-in with phone scanner should
   take under 2 minutes; adding a food charge under 10 seconds.
2. **One clear primary action per screen.**
3. **Plain words.** "Bill", not "folio" in staff-facing labels; "Guest
   details", not "CRM".
4. **Prevent mistakes** instead of explaining them later (disabled
   buttons with reasons, smart defaults, limits).
5. **Never lose typed data** (drafts, upload queue).
6. **Big touch targets** (minimum 44 × 44 px).
7. **Consistent patterns** on every screen.

---

# 68. Design System

- **Tokens** for colour, spacing (4 px grid), radius, shadows,
  typography; defined once, used everywhere
- **Light and dark mode**
- **Typography:** Inter (or similar) with tabular numbers for all money
  and tables
- **Indian formatting:** ₹1,12,000 (Indian digit grouping), dates like
  16 Sep 2026, 12-hour time with AM/PM
- **Room status colours**, always with icon + text (never colour only):
  - Ready (vacant, clean) — green
  - Occupied — blue
  - Dirty — amber
  - Cleaning — purple
  - Arriving — teal
  - Due out — orange
  - Maintenance / Out of order — red / grey
- **Components** (shadcn/ui based): button, input, searchable select,
  date range picker, stepper, drawer, dialog, toast, data table with
  sticky header, KPI card, room card, status badge, empty state,
  skeleton loader, capture tile, signature pad, Owner PIN pad
- Component library documented in Storybook (or equivalent) with light,
  dark, mobile, and loading variants

---

# 69. Motion and Animation

Library: **Motion** (formerly Framer Motion).

The product should feel smooth and premium, but **animation must never
slow staff down**.

## 69.1 Use animation for

| Moment | Animation |
|---|---|
| Check-in / checkout steps | Short slide + fade between steps (200 ms) |
| Drawers and dialogs | Slide in / scale-fade (180–220 ms) |
| Room status change | Colour cross-fade + subtle pulse once |
| Check-in, checkout, payment success | Animated checkmark (≤ 600 ms, input never blocked) |
| Dashboard KPIs | Count-up once on first load (≤ 500 ms) |
| Lists (charges added, uploads received) | Layout animation for add/remove |
| Phone scanner "✓ received" on desk | Pop-in tick |
| Calendar drag | Lift shadow, snap into place |
| Loading | Skeleton shimmer instead of spinners |
| Page transitions | Simple fade (150 ms) |

## 69.2 Rules

- Durations 150–250 ms for UI transitions; ease-out
- Animate only `transform` and `opacity` (smooth on budget phones)
- Never block typing, clicking, or scanning during an animation
- Never animate large data tables, search results, or reports
- No looping decorative animations
- Respect `prefers-reduced-motion`: replace movement with instant or fade
- Test at 60 fps on a budget Android phone

---

# 70. Home Screens

## 70.1 Reception

```text
Good morning, Priya          Business date: Wed 16 Sep   🔍 Search (Ctrl+K)

[ + New booking ] [ Walk-in ] [ Check in ] [ Check out ] [ Add charge ]

ARRIVALS (9)          DEPARTURES (6)          IN-HOUSE (14)
Rahul S. · 204 · ✓ paid adv    Amit K. · 102 · ₹4,500 due

ROOMS
[101 Ready] [102 Occupied·Dirty] [103 Arriving] [104 Out of order] …

NEEDS ATTENTION
⚠ Form C pending for Room 305 (18 h left)
⚠ Availability changed today — update OTAs: Deluxe 18–20 Sep
```

## 70.2 Owner

- Today: occupancy, revenue, collected, dues
- 7-day trend
- Owner review list (section 34.4)
- Revenue Intelligence card (AI summary if enabled)
- Data Safety badge
- Night audit status

## 70.3 Cleaner

Only assigned tasks, big buttons.

---

# 71. Search, Quick Actions and Shortcuts

- Global search (Ctrl/Cmd + K): guest, mobile, room, booking, invoice,
  vehicle, OTA reference — results grouped
- Keyboard shortcuts on desktop: `N` new booking, `I` check in, `O`
  check out, `A` add charge, `/` search (shown in a help overlay)
- Room card quick menu: add charge, view bill, shift room, mark clean,
  maintenance

---

# 72. Forms, Errors and States

- Inline validation as the user types (after first blur)
- Indian validators: mobile (10 digits, +91), GSTIN (format + checksum),
  PIN code, vehicle number, passport, IFSC
- Same Zod schemas shared by frontend and backend
- Error messages say **what happened and what to do**, e.g. "Room 204
  was just booked by someone else. Choose another room."
- Never show technical errors to staff; include a short error code for
  support
- Every screen has loading, empty, error, and offline states
- Submit buttons disable while saving; success only after server
  confirms
- Confirmation dialogs only for irreversible actions (finalize invoice,
  checkout, night audit)
- Toasts for success; persistent banner for problems needing action

---

# 73. Accessibility and Language

- WCAG 2.2 AA contrast and focus states
- Full keyboard use on desktop
- Screen-reader labels on controls
- Staff UI in English; architecture ready for Hindi (i18n keys from day
  one)
- Guest-facing text (messages, GRC, privacy notice, phone capture page)
  in English and Hindi

---

# 74. Training and Sandbox

- Guided first-login tour per role
- **Practice mode**: separate demo property with fake data; nothing
  affects real records; clearly marked with a coloured banner
- Short help tooltips on fields like GSTIN, Owner PIN, Form C
- Printable one-page guides: check-in, checkout, add charge, shift close,
  night audit
- Short in-app video/GIF walkthroughs (optional)

---

# PART K — ENGINEERING

# 75. API Design

REST, JSON, versioned under `/api/v1`. Every mutation accepts an
`Idempotency-Key` header. Money as strings. Errors as
`{ code, message, details }`.

```text
AUTH
POST   /auth/login
POST   /auth/logout
POST   /auth/pin/switch-user
POST   /auth/owner-pin/verify
POST   /auth/password/change
POST   /auth/recovery
GET    /auth/sessions
DELETE /auth/sessions/:id

PROPERTY & RATES
GET/PATCH  /property
CRUD       /rooms, /room-types, /rate-plans, /meal-plans
CRUD       /charge-items, /tax-rules

GUESTS
GET/POST   /guests
GET/PATCH  /guests/:id
POST       /guests/:id/merge

RESERVATIONS
GET/POST   /reservations
GET/PATCH  /reservations/:id
POST       /reservations/:id/cancel        (money option required if paid)
POST       /reservations/:id/no-show
GET        /availability

STAYS
POST   /check-in-drafts
PATCH  /check-in-drafts/:id
POST   /check-in-drafts/:id/confirm
POST   /stays/:id/shift-room
POST   /stays/:id/checkout
GET    /stays/:id

CAPTURE
POST   /capture-sessions                   (desk creates QR session)
GET    /capture-sessions/:token/events     (SSE for desk)
POST   /capture-sessions/:token/upload-url (phone, upload-only)
POST   /documents/:id/confirm              (checksum verification)
GET    /documents/:id/view-url             (signed, audit-logged)

BILLING
GET    /folios/:id
POST   /folios/:id/charges
POST   /folio-lines/:id/void
POST   /payments
POST   /payments/:id/reverse
POST   /refunds                             (Owner PIN)
POST   /folios/:id/discounts
POST   /folios/:id/invoice                  (finalize)
POST   /invoices/:id/credit-notes
POST   /invoices/:id/debit-notes
GET    /invoices/:id/pdf
CRUD   /company-accounts

SHIFTS & AUDIT
POST   /shifts/open
POST   /shifts/:id/close
GET    /night-audit/preview
POST   /night-audit/complete

OPERATIONS
CRUD   /housekeeping/tasks
CRUD   /maintenance/tickets
CRUD   /expenses

RECORDS & EXPORTS
GET    /records/:type
GET    /exports/:report?format=xlsx|pdf|csv
GET    /exports/tally
GET    /exports/gstr1
POST   /exports/full

GOOGLE
POST   /integrations/google/connect
GET    /integrations/google/status
POST   /integrations/google/archive

COMPLIANCE
GET/PATCH  /form-c
GET        /police-register/export
CRUD       /data-requests

REVENUE
GET    /revenue/metrics
GET    /revenue/forecast
GET    /revenue/insights
POST   /revenue/insights/refresh

SAFETY
GET    /safety/status
GET    /health  /health/db  /health/storage  /health/jobs
```

---

# 76. Database Schema (Core Tables)

```text
-- identity
users, user_pins, owner_pins, sessions, trusted_devices, recovery_codes

-- property
properties, room_types, rooms, room_status_history, room_out_of_order

-- rates & tax
rate_plans, rate_calendar, meal_plans, occupancy_rules,
charge_items, tax_rules

-- guests
guests, guest_consents, guest_flags, guest_credits,
stay_occupants, vehicles,
guest_documents, capture_sessions

-- reservations
reservations, reservation_groups, reservation_rooms,
room_allocations            -- exclusion constraint lives here
room_type_inventory

-- stays
check_in_drafts, stays, grc_documents

-- billing
folios, folio_lines, folio_line_voids,
payments, payment_reversals, refunds,
security_deposits,
invoices, invoice_lines, credit_notes, debit_notes, receipt_vouchers,
document_counters,
company_accounts, company_ledger,
ota_bookings

-- shifts
cashier_shifts, business_dates, night_audits

-- operations
housekeeping_tasks, maintenance_tickets, maintenance_schedules,
expenses, expense_categories

-- communication
message_templates, message_deliveries, outbox_events

-- records & integrations
google_connections, sheet_sync_state, drive_archives, export_logs

-- compliance
form_c_records, police_register_exports, data_requests,
retention_policies, deletion_log

-- revenue intelligence
daily_metrics, otb_snapshots, forecasts, forecast_accuracy,
revenue_insights

-- safety
audit_logs, integrity_check_runs, incidents,
backup_status, restore_test_runs

-- migration
import_jobs, import_rows

-- settings
settings, feature_flags
```

Rules:

- Every business table has `property_id` (multi-resort ready)
- `id` (UUID), `created_at`, `created_by`; `updated_at`, `updated_by`,
  `version` where editable
- Indexes on mobile, booking number, invoice number, room + dates,
  business date, OTA reference, vehicle number
- There are intentionally **no** restaurant, KOT, menu, POS, approval
  queue, payment gateway, or AI-anomaly tables

---

# 77. Environments and Deployment

## 77.1 Environments

```text
development   local, fake data
staging       same infrastructure shape as production, fake/anonymised data
production    live resorts
```

Never use real guest data outside production.

## 77.2 Hosting (recommended)

- API: containers on AWS in Mumbai (ECS Fargate or App Runner)
- Database: managed PostgreSQL (RDS) Multi-AZ, Mumbai
- Files: S3 Mumbai, replicated to Hyderabad
- Frontend: Vercel or AWS (static + server rendering); no business data
  stored at the edge
- Secrets: AWS Secrets Manager
- Off-site backups: second provider (section 53.3)

## 77.3 Delivery

- CI on every change: type check, lint, unit, integration, E2E, security
  scan
- Merge to production only when all checks pass
- Database migrations use expand → migrate → contract (no downtime,
  no destructive change in the same release)
- Fresh backup snapshot before every production migration
- Feature flags for new features
- One-click application rollback
- Deploy outside busy front-desk hours (avoid 10 AM – 2 PM and 6 PM –
  9 PM IST)

---

# 78. Observability and Alerts

- Sentry for frontend and backend errors (personal data scrubbed)
- Structured logs with request IDs
- Uptime checks every minute on `/health` endpoints
- Metrics: API latency, error rate, job queue depth, failed jobs, DB
  connections, storage errors
- **Operator alerts to phone** (push/WhatsApp/SMS) for: site down, error
  spike, failed backup, failed restore test, broken audit chain,
  integrity incident, job queue stuck
- Status page for resorts
- Weekly operator report: uptime, incidents, backups, restore tests

---

# 79. Testing Strategy

## 79.1 Unit

GST engine, slab boundaries, rounding, invoice numbering, folio
balance, discounts and limits, Owner PIN rules, occupancy/ADR/RevPAR
and all metric definitions, forecast calculations, AI number
validation, Sheets row mapping and masking.

Billing and GST code: ≥ 90% line coverage.

## 79.2 Integration

Reservation + allocation, check-in + folio + documents, add charge +
invoice, checkout + deposit + invoice, cancellation money options,
night audit posting, shift close, Sheets sync upsert, Drive archive,
restore of a backup into a test database.

## 79.3 Concurrency

Same room booked by two users; double-click check-in, payment,
checkout, finalize; charge during checkout; two night audits; parallel
invoice finalization (no gaps, no duplicates).

## 79.4 End-to-end (Playwright, desktop + mobile viewports)

```text
Walk-in → phone-scanner documents → GRC signature → check-in
→ add "Paneer Tikka × 2" and "Jeep Safari × 2"
→ room shift → night audit → checkout with card + UPI
→ invoice PDF → Sheets row appears → owner summary sent
```

Plus group booking with split bill, and cancellation with advance kept
as credit.

## 79.5 Real-device manual test matrix (every release touching capture)

iPhone Safari, Android Chrome (budget and mid-range), Windows Chrome
with USB webcam, macOS Safari — camera permission, capture, crop,
upload on weak network, resume after refresh.

## 79.6 Load

Simulate a busy resort group (for example 50 concurrent staff users,
night audit on 200 rooms) with response targets met.

## 79.7 Backup

Automated weekly restore test (section 53.5) is part of the test suite
and must be green for release.

---

# 80. Data Migration from the Old Software

Current system: the resort's existing web-based PMS (seen in reference
screenshots).

## 80.1 Getting the data

In order of preference:

1. Ask the current vendor for a full export (Excel/CSV/SQL)
2. Export lists from the old software's report screens (customers,
   check-in list, booking reports, payment transactions)
3. Last resort: manual entry of future reservations and advances only

## 80.2 Import order

```text
1 Room types and rooms
2 Guests (dedupe by mobile)
3 Future reservations + advances already received
4 Company dues and guest credits (opening balances)
5 Past stays summary (optional; enables Revenue Intelligence history)
```

## 80.3 Wizard

Upload → column mapping → dry run (valid / errors / duplicates) →
downloadable error report → owner review → import → reconciliation
report (counts and totals match source) → job can be rolled back as a
whole before go-live.

All imported rows tagged with `source = import` and job ID; everything
audit-logged.

---

# PART L — DELIVERY

# 81. Implementation Phases

## Phase 0 — Foundation

Repository, CI/CD, Next.js + NestJS + PostgreSQL, migrations, auth
(password, PINs, trusted devices), roles and limits, audit log with hash
chain, outbox + pg-boss, **backup layers 1–3 and weekly restore test
from day one**, Data Safety panel (basic), design system and motion
foundations, Sentry and alerts.

## Phase 1 — Core Front Desk

Property, rooms, room status, rate plans, meal plans, guests,
reservations, group bookings, calendar, double-booking protection,
check-in with drafts, **photo/document capture + phone scanner**,
occupants, vehicles, GRC + signature, room shift, checkout.

## Phase 2 — Billing

Folio, food/activity/other charges with saved items, payment recording,
advances, deposits, discounts + Owner PIN, GST engine, invoice
numbering, invoices, credit/debit notes, company billing, OTA tracking,
cashier shifts, night audit, printing, owner review list.

## Phase 3 — Owner Data Access

Records area, Excel/PDF exports, Tally and GSTR-1 exports, full data
export, Google Sheets mirror, Google Drive archive, owner daily summary.

## Phase 4 — Operations, Messages, Compliance

Housekeeping (+ optional cleaner mode), maintenance, expenses,
WhatsApp/email messages, Form C, police register, DPDP consent and data
requests, retention jobs.

## Phase 5 — Revenue Intelligence

Metrics (Layer 1) → Revenue dashboard and reports (Layer 2) → forecast
(Layer 3, if criteria met) → AI explanations (Layer 4, if criteria met).

## Phase 6 — Migration and Hardening

Import from old software, integrity monitoring, load tests, quarterly
restore drill, VAPT, staff training, pilot (section 83).

Each phase ends with its tests green and documentation updated.

---

# 82. Later / Optional Modules (Not in First Release)

Build only when a resort needs them:

- **Channel manager integration** through an existing Indian channel
  manager's API (do not build one) — highest priority of this list
- Website booking engine
- Guest portal (secure link: bill view, requests)
- QR room requests (towels, housekeeping, maintenance)
- Feedback and review requests
- Lost and found
- Inventory and vendors
- E-invoicing integration via a GST Suvidha Provider
- Integration with an existing restaurant POS (post food bills to room)
  if a resort runs a restaurant
- Multi-resort owner view
- Hindi staff UI

---

# 83. Pilot and Parallel Run

Before any resort relies on ResortOS:

1. Install at **one resort** while the old software keeps running
2. For **2–4 weeks**, staff enter everything in both systems
3. Every morning, compare with a checklist:
   - Occupied rooms and in-house guests
   - Room revenue, food, activities
   - Collections by method (cash, UPI, card)
   - Invoices issued: count and total
   - Pending dues
4. Every difference is explained and, if it is a ResortOS bug, fixed
   with a test added
5. **Go-live criteria:**
   - 7 consecutive days with zero unexplained differences
   - Restore drill passed on production-like data
   - All staff trained (practice mode)
   - Owner has seen Records, Sheets, Drive archive, Data Safety panel
6. Keep the old software available (read-only) for at least 30 days
   after go-live as a fallback

---

# 84. Vendor Responsibilities (Trust)

ResortOS is operated for resorts that are trusting it with their
business. Before signing a resort:

- **Service agreement:** uptime target (for example 99.5% monthly
  excluding announced maintenance), support hours and response times
  (for example critical issues answered within 30 minutes, 7 AM –
  11 PM), maintenance windows, incident communication
- **Data ownership:** the resort owns its data; full export available
  anytime and on exit; deletion confirmation after exit
- **Data processing agreement** under the DPDP Act (ResortOS as
  processor, resort as data fiduciary)
- **Backup and recovery commitment** matching Part G
- **Security:** VAPT before launch and yearly; breach notification
  process
- **Support:** WhatsApp support number, issue log, monthly check-in with
  owner
- Consider professional liability / cyber insurance
- Legal review of the agreement and privacy notice

---

# 85. Production Readiness Checklist

## Data safety

- [ ] PITR enabled, Multi-AZ
- [ ] Hyderabad backup copies and file replication working
- [ ] Off-site second-provider backups with Object Lock working
- [ ] Backup encryption key stored in two places outside primary cloud
- [ ] Weekly automated restore test passing
- [ ] Quarterly drill done
- [ ] No hard deletes on critical tables; DB triggers active
- [ ] App DB user cannot DROP/TRUNCATE
- [ ] Audit hash chain verified nightly
- [ ] Integrity checks running, incidents alerting
- [ ] Data Safety panel accurate

## Front desk

- [ ] Double booking impossible (concurrency test)
- [ ] Check-in drafts survive refresh and power cut
- [ ] Phone scanner works on iPhone and Android
- [ ] Documents cannot be marked complete until verified on server
- [ ] Group bookings and split bills correct

## Billing

- [ ] GST tests including slab boundaries
- [ ] No invoice number gaps/duplicates under concurrency
- [ ] Finalized invoices immutable at DB level
- [ ] Food/activity names appear on invoices
- [ ] Cancellation money options correct
- [ ] Shift close and night audit correct
- [ ] Tally and GSTR-1 exports accepted by the accountant

## Owner access

- [ ] Records area downloads work on phone
- [ ] Sheets mirror: no duplicates, masking correct, nightly rebuild
- [ ] Drive archive complete and verified
- [ ] Owner daily summary delivered

## Security & compliance

- [ ] Argon2id, lockout, rate limits
- [ ] Owner PIN rules and audit
- [ ] VAPT findings fixed
- [ ] Form C and police register exports verified with local practice
- [ ] DPDP notice, consents, data requests working
- [ ] CA reviewed tax settings

## UX

- [ ] Desktop, tablet, phone
- [ ] Loading, empty, error, offline states
- [ ] Animations smooth on budget Android; reduced motion respected
- [ ] Receptionist completes returning-guest check-in in under 2 minutes

## AI Revenue Intelligence

- [ ] Metrics tests pass
- [ ] If enabled: validation shows zero unmatched numbers in test packs
- [ ] No personal data in facts pack
- [ ] Read-only role verified; kill switch works
- [ ] AI outage does not affect any other feature

## Pilot

- [ ] Parallel run go-live criteria met (section 83)

---

# 86. Definition of Done

A feature is done only when:

- UI works on desktop and phone, with loading/empty/error states
- API validates input, permissions, limits, and business state
- Database constraints protect its invariants
- Transactions and idempotency in place for mutations
- Audit entries written
- Unit, integration, and (where relevant) concurrency and E2E tests pass
- Data appears correctly in reports, Records, and Sheets mirror where
  applicable
- Backup/restore impact considered (new tables included in restore
  verification)
- Documentation updated

---

# 87. Repository Structure

```text
resortos/
├── apps/
│   ├── web/                 Next.js (staff app, phone capture page)
│   └── api/                 NestJS (modules per section 8.1)
├── packages/
│   ├── ui/                  design system components + motion presets
│   ├── shared/              Zod schemas, types, money, GST engine
│   └── config/
├── db/
│   ├── migrations/          SQL migrations (constraints, triggers)
│   └── seeds/               fake data only
├── ops/
│   ├── backup/              layer 3 backup + restore test scripts
│   └── runbooks/            disaster recovery procedures
├── docs/
│   ├── architecture.md
│   ├── database.md
│   ├── data-safety.md
│   ├── security.md
│   ├── testing.md
│   └── modules/             one file per module
├── tests/
│   ├── e2e/
│   └── concurrency/
└── CLAUDE.md
```

---

# 88. CLAUDE.md Core Rules

Put these at the repository root:

```text
1.  PostgreSQL is the only source of truth. Google Sheets/Drive are
    one-way read-only copies; never read data back from them.
2.  Never hard-delete reservations, stays, folio lines, payments,
    invoices, notes, shifts, documents, or audit logs.
3.  Multi-record changes run in one transaction with audit + outbox.
4.  Every mutation supports idempotency keys.
5.  Double booking is prevented by the exclusion constraint.
6.  Backend enforces roles, receptionist limits, and Owner PIN.
7.  Money: NUMERIC(14,2) in DB, decimal library in code, strings in API.
8.  Invoice numbers come from document_counters, never a SEQUENCE.
9.  Finalized invoices are immutable (DB trigger); corrections via
    credit/debit notes.
10. Tax rates come from dated tax_rules; never hard-code rates.
11. Documents: verified checksum before a check-in can be confirmed;
    signed short-lived URLs only; every view logged. No ID type is
    treated specially.
12. Never send ID data, photos, full phones, addresses, or flags to
    Google, messages, logs, or the AI provider.
13. External services (WhatsApp, email, Google, AI) run after commit
    and can never break a transaction.
14. Roles: Owner, Receptionist, optional task-only Cleaner. No manager
    role, no approval queue.
15. No payment gateway. Payments are recorded, not processed.
16. No restaurant/POS/KOT system. Food and activities are named folio
    charge lines.
17. Only AI feature: Revenue Intelligence. Read-only role, aggregated
    data, LLM narrates backend-computed numbers, every number validated,
    feature flag, never mutates anything.
18. Backups: PITR + second region + second provider with Object Lock;
    restore tests must pass.
19. Animations: 150–250 ms, transform/opacity only, never block input,
    respect reduced motion.
20. Build one module at a time; tests green before moving on; update
    docs.
```

---

# 89. Final Rule

**Do not build something that only looks complete.**

Build a system where:

```text
A booking cannot silently conflict.
A payment cannot silently duplicate.
An invoice cannot silently change or skip a number.
A document cannot be "received" unless it is safely stored.
A receptionist cannot act beyond their limit without the owner.
A deleted-looking record is still in history.
A failed WhatsApp, Google, or AI call cannot break the hotel.
A backup always exists in a place the primary cloud cannot delete.
A restore has actually been tested.
An owner with no technical knowledge can see their data and know it is safe.
```

**Simple for people. Strict for data. Recoverable in failure.**
