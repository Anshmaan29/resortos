/**
 * Row shapes returned by PostgreSQL. The pg driver is configured (db.service.ts) so that
 * NUMERIC, DATE and BIGINT arrive as strings; timestamptz arrives as Date.
 */
import type { HousekeepingStatus, MealPlanCode, ReservationStatus, Role, ServiceStatus } from '@resortos/shared';

type Money = string;
type IsoDate = string;

export interface CountRow { n: string }
export interface IdRow { id: string }

export interface PropertyRow {
  id: string; name: string; legal_name: string; address_line1: string; address_line2: string | null; city: string;
  state_code: string; pin_code: string; gstin: string | null; phone: string; email: string | null; logo_path: string | null;
  check_in_time: string; check_out_time: string; timezone: string; financial_year_start_month: number;
  current_business_date: IsoDate; is_practice: boolean; data_origin: 'live' | 'demo'; created_at: Date; updated_at: Date; version: number;
}

export interface UserRow {
  id: string; property_id: string; full_name: string; username: string; mobile: string | null; email: string | null; role: Role;
  password_hash: string; must_change_password: boolean; password_changed_at: Date | null;
  discount_limit_percent: Money; can_run_night_audit: boolean; can_prepare_compliance: boolean;
  staff_pin_hash: string | null; owner_pin_hash: string | null; owner_pin_failed_count: number; owner_pin_locked_until: Date | null;
  login_throttle_reset_at: Date | null; is_active: boolean; is_demo: boolean; created_at: Date; version: number;
}

export interface RoomTypeRow {
  id: string; property_id: string; code: string; name: string; description: string | null; base_occupancy: number; max_occupancy: number;
  base_rate: Money; min_rate: Money; extra_adult_rate: Money; extra_child_rate: Money; sort_order: number; is_active: boolean; version: number;
}

export interface RoomRow {
  id: string; property_id: string; room_type_id: string; number: string; unit_type: string; view: string | null; building: string | null;
  floor: string | null; amenities: string[]; is_accessible: boolean; notes: string | null; housekeeping_status: HousekeepingStatus;
  service_status: ServiceStatus; sort_order: number; is_active: boolean; version: number;
}

export interface MealPlanRow {
  id: string; code: MealPlanCode; name: string; adult_rate: Money; child_rate: Money; post_separately: boolean; is_active: boolean;
}

export interface RatePlanRow { id: string; code: string; name: string; kind: string; is_default: boolean; is_active: boolean }

export interface RateCalendarRow {
  id: string; rate_plan_id: string; room_type_id: string; label: string; start_date: IsoDate; end_date: IsoDate;
  days_of_week: (number | string)[]; rate: Money; min_stay: number | null; priority: number; created_at: Date;
}

export interface TaxRuleRow {
  id: string; tax_category: 'accommodation' | 'food' | 'activity' | 'laundry' | 'transport' | 'other';
  unit_value_above: Money | null; unit_value_up_to: Money | null; rate_percent: Money; sac: string;
  effective_from: IsoDate; effective_to: IsoDate | null; note: string | null; origin: 'configured' | 'demo_placeholder';
}

export interface GuestRow {
  id: string; property_id: string; first_name: string; last_name: string; mobile: string; email: string | null; address_line: string | null;
  city: string | null; state: string | null; pin_code: string | null; country: string; nationality: string; company_name: string | null;
  company_gstin: string | null; preferences: string | null; is_vip: boolean; special_note: string | null; merged_into_id: string | null; version: number;
}

export interface ReservationRow {
  id: string; property_id: string; number: string; primary_guest_id: string; source: string; ota_reference: string | null;
  arrival: IsoDate; departure: IsoDate; status: ReservationStatus; group_name: string | null; group_leader_guest_id: string | null;
  billing_mode: string; special_requests: string | null; internal_notes: string | null; cancelled_at: Date | null; cancel_reason: string | null;
  cancel_note: string | null; cancel_money_option: string | null; rebooked_from_id: string | null; created_at: Date; created_by: string | null; version: number;
}

export type ReservationRoomStatus = 'reserved' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show' | 'replaced';

export interface ReservationRoomRow {
  id: string; property_id: string; reservation_id: string; room_type_id: string; room_id: string | null; arrival: IsoDate; departure: IsoDate;
  adults: number; child_ages: (number | string)[]; rate_plan_id: string | null; meal_plan: MealPlanCode; nightly_rate: Money;
  rate_authorised_by: string | null; status: ReservationRoomStatus; created_at: Date; version: number;
}

export interface NightRow {
  reservation_room_id: string; night_date: IsoDate; room_rate: Money; extra_person_amount: Money; meal_amount: Money;
  rate_source: 'base' | 'calendar' | 'manual';
}

export interface OwnerAuthorisationRow {
  id: string; property_id: string; requested_by: string; operation: string; scope_hash: Buffer; reasons: unknown; description: string;
  created_at: Date; request_expires_at: Date; approved_by: string | null; approved_at: Date | null; expires_at: Date | null; used_at: Date | null;
}
