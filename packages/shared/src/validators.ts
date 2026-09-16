/** Indian field validators (spec §72). Shared by web forms and API DTOs. */

/** Normalises Indian mobile input to E.164 ("+919876543210"), or null if invalid. */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** International numbers for foreign guests: "+" then 8–15 digits. */
export function isE164(input: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(input);
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]!);
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (total % 36)) % 36]!;
}

/** Format + state code + checksum. */
export function isValidGstin(input: string): boolean {
  const g = input.trim().toUpperCase();
  if (!GSTIN_FORMAT.test(g)) return false;
  const state = Number(g.slice(0, 2));
  if (state < 1 || (state > 38 && state !== 97 && state !== 99)) return false;
  return gstinCheckChar(g.slice(0, 14)) === g[14];
}

export function stateCodeFromGstin(gstin: string): string {
  return gstin.slice(0, 2);
}

export function isValidPinCode(input: string): boolean {
  return /^[1-9]\d{5}$/.test(input.trim());
}

export function isValidIfsc(input: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.trim().toUpperCase());
}

/** "RJ 14 CX 1234" → "RJ14CX1234" */
export function normalizeVehicleNumber(input: string): string {
  return input.toUpperCase().replace(/[\s\-.]/g, '');
}

/** Standard state series (RJ14CX1234, DL3CAB1234) or Bharat series (22BH1234AA). */
export function isValidIndianVehicleNumber(input: string): boolean {
  const v = normalizeVehicleNumber(input);
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(v) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(v);
}

export function isValidPassportNumber(input: string): boolean {
  return /^[A-Z0-9]{6,9}$/.test(input.trim().toUpperCase());
}

/** Aadhaar: we only ever keep the last 4 digits (spec §58.3). */
export function aadhaarLast4(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Indian state codes used for GST place of supply. */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
