import type { HousekeepingStatus, IdType, MealPlanCode, OccupancyStatus, ReservationStatus, Role, RoomDisplayState, ServiceStatus } from '@resortos/shared';

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
  groupName: string | null; billingMode: string; specialRequests: string | null; internalNotes: string | null;
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
  status: 'pending' | 'verified' | 'failed' | 'orphaned'; source: string; sizeBytes: number; maskedOnDevice: boolean;
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
