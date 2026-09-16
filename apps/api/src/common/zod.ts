import { ERROR_CODES } from '@resortos/shared';
import type { z } from 'zod';
import { AppError } from './errors';

/** Validates input with a shared Zod schema; errors carry field paths for inline form messages. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(ERROR_CODES.VALIDATION, fields[0]?.message ?? 'Please check the form.', { fields });
  }
  return result.data;
}
