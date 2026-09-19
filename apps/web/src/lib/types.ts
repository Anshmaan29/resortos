import type {
  AddableLineType, FolioLineType, PaymentAccountKind, PaymentEntryType, PaymentMethod, HousekeepingStatus, IdType, MealPlanCode, OccupancyStatus, ReservationStatus, Role, RoomDisplayState, ServiceStatus, VisitPurpose } from '@resortos/shared';

export interface Me { id: string; propertyId: string; fullName: string; username: string; role: Role; discountLimitPercent: string; mustChangePassword: boolean; canRunNightAudit: boolean }
export interface Property { id: string; name: string; legalName: string; city: string; stateCode: string; gstin: string | null; businessDate: string; checkInTime: string; checkOutTime: string; isPractice: boolean; version: number }
export interface RoomType { id: string; code: string; name: string; baseOccupancy: number; maxOccupancy: number; baseRate: string; minRate: string; extraAdultRate: string; extraChildRate: string; isActive: boolean; version: number }
export interface Room {
  id: string; number: string; roomTypeId: string; roomTypeName: string; roomTypeCode: string; unitType: string; view: string | null;
  building: string | null; floor: string | null; housekeeping: HousekeepingStatus; service: ServiceStatus; occupancy: OccupancyStatus;
  displayState: RoomDisplayState; sellable: boolean; version: number;
  currentReservation: { id: string; number: string; guestName: string; isVip: boolean; arrival: string; departure: string } | null;
}
export interface ReservationListItem {
  id: string; number: string; status: ReservationStatus; source: string; sourceLabel: string; otaReference: string | null; arrival: string; departure: string;
  nights: number; groupName: string | null; guestName: string; mobile: string; isVip: boolean; roomCount: number; roomNumbers: string | null; roomTypes: string | null; total: string;
}
export interface TaxGroup { ratePercent: string; taxableValue: string; cgst: string; sgst: string; igst: string }
export interface TaxEstimate {
  roomTotal: string; extrasTotal: string; mealTotal: string; taxableTotal: string; available: boolean; message: string | null;
  taxTotal: string | null; roundOff: string | null; grandTotal: string | null; groups: TaxGroup[]; usesPlaceholderRates: boolean;
}
export interface ReservationDetail {
  id: string; number: string; status: ReservationStatus; source: string; sourceLabel: string; otaReference: string | null; arrival: string; departure: string; nights: number;
  groupName: string | null; billingMode: string; purpose: VisitPurpose | null; specialRequests: string | null; internalNotes: string | null;
  guest: { id: string; firstName: string; lastName: string; fullName: string; mobile: string; email: string | null; isVip: boolean; city: string | null };
  rooms: {
    id: string; roomTypeId: string; roomTypeName: string; roomId: string | null; roomNumber: string | null; adults: number; childAges: number[]; mealPlan: MealPlanCode;
    nightlyRate: string; roomTotal: string; extrasTotal: string; mealTotal: string; total: string; status: string; rateAuthorisedBy: string | null;
  }[];
  estimate: TaxEstimate;
  advancePaid: string;
  overrides: { action: string; description: string; at: string; performedBy: string; authorisedBy: string; authorisedByRole: string }[];
  rebookedFrom: { id: string; number: string } | null;
  rebookedAs: { id: string; number: string; status: ReservationStatus }[];
  checkIn: { ready: boolean; blockers: string[]; notes: string[] };
  stays: { id: string; roomNumber: string; status: 'in_house' | 'checked_out' }[];
  canEdit: boolean; canRebook: boolean; businessDate: string;
  cancelledAt: string | null; cancelReason: string | null; cancelNote: string | null; createdAt: string; createdBy: string | null; version: number;
}
export interface BookingEstimate {
  rooms: { roomTypeId: string; nightCount: number; roomTotal: string; extrasTotal: string; mealTotal: string; total: string; averageRoomRate: string; minRate: string;
    belowFloor: boolean; keptAgreedRates: boolean; minStay: number; minStayViolated: boolean; labels: string[] }[];
  tax: TaxEstimate;
}
export interface FrontDesk {
  businessDate: string; arrivals: ReservationListItem[];
  departures: { id: string; number: string; departure: string; guestName: string; isVip: boolean; roomNumbers: string | null; overdue: boolean }[];
  inHouseRooms: number; roomCounts: Partial<Record<RoomDisplayState, number>>; totalRooms: number;
}
export interface Guest { id: string; firstName: string; lastName: string; fullName: string; mobile: string; email: string | null; city: string | null; isVip: boolean; stays?: number; lastStay?: string | null; version: number }
export interface Availability {
  arrival: string; departure: string; nights: number;
  roomTypes: { roomTypeId: string; roomTypeName: string; available: number; nights: { date: string; capacity: number; booked: number; available: number }[]; freeRooms: { id: string; number: string; view: string | null; housekeeping: string }[] }[];
}
export interface Quote {
  nights: { date: string; roomRate: string; extraPersonAmount: string; mealAmount: string; total: string; rateSource: string; label: string | null; belowFloor: boolean }[];
  nightCount: number; roomTotal: string; extrasTotal: string; mealTotal: string; total: string; averageRoomRate: string; minRate: string; belowFloor: boolean; minStay: number; minStayViolated: boolean;
}
export interface CalendarData {
  from: string; to: string; days: number;
  rooms: { id: string; number: string; roomTypeId: string; roomTypeName: string; housekeeping: string; service: string }[];
  bookings: { allocationId: string; roomId: string; start: string; end: string; allocationStatus: string; reservationId: string; number: string; status: ReservationStatus; source: string; groupName: string | null; guestName: string; isVip: boolean; adults: number; children: number }[];
  unassigned: { reservationRoomId: string; roomTypeId: string; roomTypeName: string; start: string; end: string; reservationId: string; number: string; status: ReservationStatus; guestName: string }[];
  outOfOrder: { id: string; roomId: string; start: string; end: string; reason: string }[];
}

export interface StayDocument {
  id: string; docType: string; label: string; idType: string | null; occupantKey: string | null;
  status: 'pending' | 'verified' | 'failed' | 'orphaned'; source: string; sizeBytes: number;
  createdAt: string; verifiedAt: string | null; failureReason: string | null;
}
export interface StayDetail {
  id: string; status: 'in_house' | 'checked_out'; reservationId: string; reservationNumber: string;
  guestName: string; mobile: string; isVip: boolean;
  roomId: string; roomNumber: string; roomTypeId: string; roomTypeName: string;
  adults: number; childAges: number[]; mealPlan: MealPlanCode; nightlyRate: string;
  checkedInAt: string; businessDateIn: string; expectedDeparture: string;
  checkedOutAt: string | null; businessDateOut: string | null; earlyDeparture: boolean;
  businessDate: string; canShiftRoom: boolean; version: number;
  occupants: { key: string; fullName: string; isPrimary: boolean; isChild: boolean; age: number | null; nationality: string; idType: IdType; idLast4: string | null }[];
  vehicles: { registration: string; vehicleType: string; parkingSlot: string | null }[];
  documents: StayDocument[];
  shifts: { from: string; to: string; businessDate: string; reason: string; rateDecision: string; at: string; by: string }[];
}
export interface CheckoutPreview {
  stayId: string; status: 'in_house' | 'checked_out'; businessDate: string; expectedDeparture: string;
  earlyDeparture: boolean; steps: string[]; blockers: { step: string; message: string }[];
}
export interface GrcVersion {
  id: string; number: string; version: number; supersedesId: string | null; sizeBytes: number; sha256: string;
  signatureMethod: 'touchscreen' | 'phone' | 'paper_scan'; signedAt: string; noticeVersion: string; generatedAt: string; reason: string | null;
}
export interface GrcList { stayId: string; current: GrcVersion | null; versions: GrcVersion[] }

export interface GuestProfile extends Omit<Guest, 'stays'> {
  addressLine: string | null; state: string | null; pinCode: string | null; country: string;
  companyName: string | null; companyGstin: string | null; preferences: string | null; specialNote: string | null;
  mergedIntoId: string | null; documentsRestricted: boolean;
  history: { id: string; number: string; arrival: string; departure: string; status: ReservationStatus; source: string; purpose: VisitPurpose | null; rooms: string | null }[];
  upcoming: { id: string; number: string; arrival: string; departure: string; status: ReservationStatus; rooms: string | null }[];
  stays: { id: string; roomNumber: string; status: 'in_house' | 'checked_out'; checkedIn: string; dueOut: string; checkedOut: string | null }[];
  vehicles: { registration: string; vehicleType: string; parkingSlot: string | null }[];
  documents: { id: string; docType: string; idType: string | null; roomNumber: string; at: string; current: boolean }[];
}
export interface StayListItem {
  id: string; status: 'in_house' | 'checked_out'; roomNumber: string; roomTypeName: string;
  guestId: string; guestName: string; mobile: string; isVip: boolean;
  reservationId: string; reservationNumber: string; purpose: VisitPurpose | null;
  checkedIn: string; dueOut: string; checkedOut: string | null; earlyDeparture: boolean;
  adults: number; children: number; occupants: number;
}
export interface RoomShiftLogItem {
  id: string; businessDate: string; from: string; to: string; reason: string; rateDecision: string;
  at: string; by: string; authorisedBy: string | null; stayId: string; guestName: string;
}
export interface SearchHit { kind: 'guest' | 'booking' | 'room' | 'vehicle'; id: string; href: string; title: string; subtitle: string }

export interface NightAuditItem { id: string; label: string; href: string | null; actions: string[] }
export interface NightAuditStepView {
  name: string; title: string; blocking: boolean;
  items: NightAuditItem[]; warnings: string[]; willDo: string | null;
}
export interface NightAuditRun {
  id: string; businessDate: string; startedAt: string; completedAt: string; completedBy: string;
  steps: { name: string; title: string; posted: number; skipped: number }[];
  summary: Record<string, number>;
}
export interface NightAuditPreview {
  businessDate: string; nextBusinessDate: string; alreadyCompleted: NightAuditRun | null;
  canComplete: boolean; blocked: boolean; mayRun: boolean;
  steps: NightAuditStepView[]; summary: Record<string, number>;
}

export interface BillLine {
  id: string; businessDate: string; lineType: FolioLineType; name: string;
  quantity: number; unitRate: string; amount: string; taxCategory: string;
  source: 'manual' | 'night_audit' | 'import'; note: string | null;
  at: string; by: string;
  voided: boolean; voidedAt: string | null; voidReason: string | null; voidedBy: string | null;
  appliesToLineId: string | null; discountGroupId: string | null; discountPercent: string | null; discountReason: string | null;
  hasDiscount: boolean; net: string | null; gstRate: string | null;
}
export interface DiscountPreview {
  discount: string; percentOfCharges: string; needsOwner: boolean; yourLimitPercent: string;
  parts: { lineId: string; name: string; amount: string }[];
  before: { taxTotal: string | null; grandTotal: string | null };
  after: { taxTotal: string | null; grandTotal: string | null };
  slabChanges: { lineId: string; name: string; businessDate: string; fromRate: string; toRate: string }[];
}
export interface Bill {
  id: string; number: string; stayId: string | null; reservationId: string; reservationNumber: string;
  status: 'open' | 'closed'; kind: string; version: number; businessDate: string;
  guestName: string; roomNumber: string | null;
  lines: BillLine[];
  charges: string;
  tax: {
    available: boolean; message: string | null; taxTotal: string | null; roundOff: string | null;
    grandTotal: string | null; groups: { ratePercent: string; taxableValue: string; cgst: string; sgst: string; igst: string }[];
    usesPlaceholderRates: boolean;
  };
  payments: BillPayment[];
  paid: string;
  depositHeld: string;
  total: string | null;
  documents: { id: string; number: string; documentType: DocumentType; grandTotal: string; invoiceDate: string }[];
  pendingInvoice: boolean;
  balance: string | null;
}
export interface ChargeItem {
  id: string; name: string; lineType: AddableLineType; defaultRate: string;
  taxCategory: string; isActive: boolean; sortOrder: number; version: number;
}

export interface BillPayment {
  id: string; number: string; folioId: string | null; reservationId: string;
  entryType: PaymentEntryType; method: PaymentMethod; accountId: string | null; accountName: string | null;
  amount: string; billEffect: string; depositEffect: string; cashEffect: string;
  reference: string | null; note: string | null;
  businessDate: string; at: string; by: string;
  isReversal: boolean; reverses: string | null; reversalReason: string | null;
  reversed: boolean; reversedAt: string | null; reversedReason: string | null;
  status: 'recorded' | 'reversed';
}
export interface PaymentAccount {
  id: string; name: string; kind: PaymentAccountKind; bankName: string | null; accountLast4: string | null;
  upiHandle: string | null; posTerminal: string | null; openingBalance: string;
  isActive: boolean; sortOrder: number; version: number;
}

export interface ShiftAccountTotal { id: string; name: string; kind: PaymentAccountKind; amount: string; entries: number }
export interface Shift {
  id: string; businessDate: string; status: 'open' | 'closed';
  openedAt: string; openedBy: string; openedById: string; openingCash: string;
  closedAt: string | null; closedBy: string | null;
  accounts: ShiftAccountTotal[];
  expectedCash: string; expectedCard: string; countedCash: string | null; posBatchTotal: string | null;
  cashDifference: string | null; cardDifference: string | null; differenceReason: string | null; handoverNote: string | null;
  cashDifferenceThreshold: string;
  payments: { id: string; number: string; entryType: PaymentEntryType; method: PaymentMethod; amount: string; cashEffect: string; accountName: string | null; reference: string | null; at: string; isReversal: boolean }[];
  version: number;
}
export interface CurrentShift {
  shift: Shift | null;
  lastClosed: { countedCash: string; closedAt: string; closedBy: string; handoverNote: string | null } | null;
}
export interface ShiftListItem {
  id: string; businessDate: string; status: 'open' | 'closed'; openedAt: string; openedBy: string;
  closedAt: string | null; closedBy: string | null; openingCash: string; countedCash: string | null;
  expectedCash: string | null; cashDifference: string | null; differenceReason: string | null;
}
export interface AccountBalance { id: string; name: string; kind: PaymentAccountKind; openingBalance: string; received: string; entries: number; balance: string }
export interface AccountLedger {
  account: { id: string; name: string; kind: PaymentAccountKind };
  from: string | null; to: string | null; openingBalance: string; closingBalance: string;
  lines: { source: string; sourceId: string; reference: string; businessDate: string; at: string; by: string; description: string; amount: string; balance: string }[];
}

export type DocumentType = 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note';
export interface TaxGroup { ratePercent: string; taxableValue: string; cgst: string; sgst: string; igst: string }
export interface InvoiceLine {
  businessDate: string; description: string; sac: string; quantity: string; rate: string;
  gross: string; discount: string; taxable: string; gstRate: string;
}
export interface InvoicePreview {
  documentType: DocumentType; invoiced: { id: string; number: string } | null;
  seller: { legalName: string; address: string; gstin: string | null; stateCode: string };
  buyer: { name: string; gstin: string | null; address: string | null; stateCode: string | null };
  lines: InvoiceLine[]; groups: TaxGroup[];
  taxableTotal: string; cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string;
}
export interface Invoice {
  id: string; folioId: string; documentType: DocumentType; number: string; invoiceDate: string;
  original: { id: string; number: string } | null; reason: string | null;
  seller: InvoicePreview['seller']; buyer: InvoicePreview['buyer'] & { mobile: string | null };
  placeOfSupply: string; stay: { from: string | null; to: string | null; rooms: string | null; reservationNumber: string | null };
  lines: (InvoiceLine & { id: string; lineNo: number; creditsLineId: string | null })[]; groups: TaxGroup[];
  taxableTotal: string; cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string;
  paidAtIssue: string; balanceAtIssue: string; paid: { method: string; amount: string }[];
  corrections: { id: string; number: string; documentType: DocumentType; grandTotal: string; invoiceDate: string }[];
  finalizedAt: string; finalizedBy: string;
}
export interface InvoiceRegisterRow {
  id: string; number: string; documentType: DocumentType; invoiceDate: string; buyerName: string; buyerGstin: string | null;
  taxable: string; cgst: string; sgst: string; igst: string; total: string; originalNumber: string | null;
}
export interface Company {
  id: string; name: string; gstin: string | null; billingAddress: string | null; contactPerson: string | null;
  phone: string | null; email: string | null; creditLimit: string | null; paymentTermsDays: number;
  isActive: boolean; version: number; outstanding: string | null;
}
export interface CompanyStatement {
  company: Company; outstanding: string; asOf: string; pastTermsGross: string;
  ageing: { label: string; amount: string }[];
  lines: { kind: 'bill' | 'receipt'; id: string; reference: string; businessDate: string; description: string; debit: string; credit: string; balance: string }[];
}
export interface OtaReceivables {
  items: {
    reservationId: string; number: string; source: string; otaReference: string; arrival: string; departure: string; status: string;
    guestName: string; paymentMode: string | null; grossAmount: string | null; commissionAmount: string | null; taxWithheld: string | null;
    expectedPayout: string | null; received: string; pending: string | null; difference: string | null; termsMissing: boolean;
  }[];
  totals: { booked: string; expected: string; received: string; pending: string };
}
export interface OtaTerms {
  reservationId: string; paymentMode: 'prepaid_to_ota' | 'pay_at_resort'; grossAmount: string; commissionAmount: string;
  taxWithheld: string; expectedPayout: string; note: string | null; version: number; received: string;
}
