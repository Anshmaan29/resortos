import { z } from 'zod';
import { money, round2, roundRupee, toMoneyString } from './money';
import { guestSchema, zId, zNonNegativeMoney } from './schemas';
export const VILLA_USES = [
  'one_bedroom',
  'both_bedrooms',
  'whole_villa',
  'pool',
  'garden',
] as const;
export const VILLA_BOOKABLE_USES = ['one_bedroom', 'both_bedrooms', 'pool', 'garden'] as const;
export const VILLA_USE_LABELS: Record<(typeof VILLA_USES)[number], string> = {
  one_bedroom: 'One room',
  both_bedrooms: '2 rooms',
  whole_villa: 'Whole villa (previous booking)',
  pool: 'Swimming pool',
  garden: 'Garden',
};
export const villaDayUse = (kind: string) => kind === 'pool' || kind === 'garden';
export const villaBookingSchema = z
  .object({
    useKind: z.enum(VILLA_USES),
    roomId: zId.optional(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    guestCount: z.number().int().min(1).max(1000),
    price: zNonNegativeMoney,
    gstPercent: zNonNegativeMoney.refine((v) => Number(v) <= 100, 'GST must be between 0 and 100%'),
    guest: guestSchema.optional(),
    guestId: zId.optional(),
    notes: z.string().trim().max(1000).optional(),
    mealPlan: z.enum(['EP', 'CP', 'MAP', 'AP']).default('EP'),
    version: z.number().int().min(1).optional(),
  })
  .refine((v) => v.guest || v.guestId, { message: 'Choose or add a guest', path: ['guest'] })
  .refine((v) => v.useKind !== 'one_bedroom' || !!v.roomId, {
    message: 'Choose Room 1 or Room 2',
    path: ['roomId'],
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: 'End must be after start',
    path: ['endsAt'],
  })
  .refine((v) => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 91 * 86400000, {
    message: 'Choose at most 90 nights',
    path: ['endsAt'],
  })
  .refine((v) => villaDayUse(v.useKind) || v.guestCount <= 20, {
    message: 'Use at most 20 overnight guests',
    path: ['guestCount'],
  });
export type VillaBookingInput = z.infer<typeof villaBookingSchema>;

/** Same CGST/SGST group rounding and final rupee rounding as the invoice engine. */
export function villaBookingTotal(price: string, gstPercent: string, units = 1): string {
  const base = money(price).times(units);
  const half = round2(base.times(gstPercent).div(200));
  return toMoneyString(roundRupee(base.plus(half.times(2))));
}
