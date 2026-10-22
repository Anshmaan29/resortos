import { normalizeIndianMobile } from '@resortos/shared';

/** Autofill only an exact, unique mobile match; partial numbers/names always need a choice. */
export function uniqueReturningGuest<T extends { mobile: string; fullName?: string; firstName?: string; lastName?: string }>(
  candidates: T[], input: string, enteredName = '',
): T | undefined {
  const mobile = normalizeIndianMobile(input);
  if (!mobile) return;
  const matching = candidates.filter(g => normalizeIndianMobile(g.mobile) === mobile);
  if (matching.length !== 1) return;
  const guest = matching[0]!;
  const name = (guest.fullName ?? `${guest.firstName ?? ''} ${guest.lastName ?? ''}`).trim().toLowerCase();
  if (enteredName.trim() && enteredName.trim().toLowerCase() !== name) return;
  return guest;
}
