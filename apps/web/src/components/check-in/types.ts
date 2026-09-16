import type { CheckInDraftData, DocumentType, IdType, MealPlanCode } from '@resortos/shared';

export interface DraftDocument {
  id: string; docType: DocumentType; label: string; idType: Exclude<IdType, 'none'> | null; occupantKey: string | null;
  status: 'pending' | 'verified' | 'failed' | 'orphaned'; source: string; sizeBytes: number; maskedOnDevice: boolean;
  createdAt: string; verifiedAt: string | null; failureReason: string | null;
}

export interface CheckInDraft {
  id: string;
  reservationId: string;
  reservationRoomIds: string[];
  step: number;
  data: CheckInDraftData;
  status: 'active' | 'confirmed' | 'abandoned';
  version: number;
  updatedAt: string;
  documents: DraftDocument[];
  policy: { idRequiredFor: 'all_adults' | 'primary_guest'; requireGuestPhoto: boolean; requireSignature: boolean };
  problems: { path: string; message: string }[];
  reservation: {
    number: string; arrival: string; departure: string; guestName: string; mobile: string; isVip: boolean; specialRequests: string | null;
    rooms: { reservationRoomId: string; roomTypeId: string; roomTypeName: string; roomId: string | null; roomNumber: string | null; adults: number; childAges: number[]; mealPlan: MealPlanCode; status: string }[];
  };
}

export type Occupant = CheckInDraftData['rooms'][number]['occupants'][number];
export type Vehicle = CheckInDraftData['rooms'][number]['vehicles'][number];

export const STEPS = [
  { n: 1, title: 'Guests', short: 'Guests' },
  { n: 2, title: 'Room', short: 'Room' },
  { n: 3, title: 'Documents', short: 'IDs' },
  { n: 4, title: 'Registration & signature', short: 'Sign' },
  { n: 5, title: 'Confirm', short: 'Confirm' },
] as const;
