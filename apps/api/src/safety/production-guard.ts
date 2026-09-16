import type { Queryable } from '../db/db.service';

export class UnsafeProductionDataError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to start in production: ${problems.join('; ')}`);
    this.name = 'UnsafeProductionDataError';
  }
}

/**
 * Production boot check (spec §77.1, §85). Demo properties, demo logins (and their known
 * Owner PIN) and placeholder GST rules must never serve real guests.
 */
export async function assertProductionSafe(q: Queryable): Promise<void> {
  const { rows } = await q.query<{ demo_properties: string; demo_users: string; placeholder_tax_rules: string }>(
    `SELECT (SELECT count(*) FROM properties WHERE data_origin = 'demo') AS demo_properties,
            (SELECT count(*) FROM users WHERE is_demo AND is_active) AS demo_users,
            (SELECT count(*) FROM tax_rules WHERE origin = 'demo_placeholder' AND (effective_to IS NULL OR effective_to >= current_date)) AS placeholder_tax_rules`,
  );
  const r = rows[0]!;
  const problems: string[] = [];
  if (Number(r.demo_properties)) problems.push(`${r.demo_properties} demo property/properties present`);
  if (Number(r.demo_users)) problems.push(`${r.demo_users} active demo login(s) present`);
  if (Number(r.placeholder_tax_rules)) problems.push(`${r.placeholder_tax_rules} placeholder GST rule(s) still in effect — replace with CA-confirmed rules`);
  if (problems.length) throw new UnsafeProductionDataError(problems);
}
