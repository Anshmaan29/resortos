import { describe, expect, it } from 'vitest';
import { latestDocuments } from '../src/stays/document-slots';

const doc = (id: string, occupant_key: string | null, doc_type: string, created_at: Date) => ({ id, occupant_key, doc_type, created_at });
describe('current guest document slots', () => {
  it('selects by capture creation, preserves each guest and keeps generated card versions', () => {
    const earlier = new Date('2026-10-06T10:00:00Z');
    const later = new Date('2026-10-06T10:00:01Z');
    const documents = [doc('old', 'guest1', 'id_back', earlier), doc('new', 'guest1', 'id_back', later),
      doc('other-guest', 'guest2', 'id_back', earlier), doc('front', 'guest1', 'id_front', earlier),
      doc('signature1', null, 'signature', earlier), doc('signature2', null, 'signature', later),
      doc('grc1', null, 'grc', earlier), doc('grc2', null, 'grc', later)];
    expect(latestDocuments(documents).map((d) => d.id).sort()).toEqual(['new', 'other-guest', 'front', 'signature2', 'grc1', 'grc2'].sort());
  });
});
