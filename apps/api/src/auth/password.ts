import argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashSecret = (plain: string) => argon2.hash(plain, OPTIONS);

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Spend the same time on unknown usernames so response timing does not reveal which accounts exist. */
export async function burnVerifyTime(plain: string): Promise<void> {
  dummyHash ??= hashSecret('resortos-dummy-password-for-timing');
  await verifySecret(await dummyHash, plain);
}

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '0123456789', '12345678910', 'qwertyuiop', 'iloveyou123',
  'welcome123', 'admin12345', 'letmein123', 'qwerty12345', 'abcdefghij', 'abcd123456', 'india12345', 'resort1234',
  'resortos123', 'hotel12345', 'reception1', 'reception123', '1111111111', '0000000000', '9876543210',
]);

/** Returns a plain-language problem, or null if acceptable (spec §5.1). */
export function passwordProblem(password: string, context: { username?: string; fullName?: string; mobile?: string | null }): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/.test(password)) return 'Do not use the same character repeated.';
  if (context.username && lower.includes(context.username.toLowerCase())) return 'Do not include your username in the password.';
  const digits = context.mobile?.replace(/\D/g, '').slice(-10);
  if (digits && password.includes(digits)) return 'Do not use your mobile number as the password.';
  return null;
}

/** Owner PIN must not be trivially guessable. */
/** Staff quick-switch PIN (spec §5.3): 4–6 digits, not all the same, not a run. */
export function staffPinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Do not use the same digit throughout.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Do not use digits in a sequence.';
  return null;
}

export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'PIN must be exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Do not use the same digit six times.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Do not use digits in a sequence.';
  return null;
}
