import { describe, expect, it } from 'vitest';
import { safeProjection } from './safe-projection';
describe('Google mirror privacy', () => {
  it('masks mobile and refuses to automatically copy sensitive or newly added export fields', () => {
    const out = safeProjection('guests', { title:'Guests', columns:['Guest','Mobile','Email','Address','VIP','Note','Bookings','Last arrival','Added on','New private field'],
      rows:[['Test Guest','+919829001234','private@example.com','Private address','Yes','Private note',{number:'2'},'2026-10-01','2026-09-01','Private extra']] });
    expect(out.columns).toEqual(['Guest','Mobile','Bookings','Last arrival','Added on']);
    expect(out.rows[0]).toEqual(['Test Guest','••••1234',{number:'2'},'2026-10-01','2026-09-01']);
    expect(JSON.stringify(out)).not.toContain('Private');
    expect(() => safeProjection('form-c', {title:'Form C',columns:[],rows:[]})).toThrow();
    expect(() => safeProjection('guests', {title:'Guests',columns:[],rows:[]})).toThrow();
  });
});
