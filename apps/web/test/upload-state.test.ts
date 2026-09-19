import { describe, expect, it } from 'vitest';
import { BLOCKED_MESSAGE, isBlocked } from '../src/lib/capture/upload-queue';
import { slotState } from '../src/lib/capture/slot-state';

/**
 * What the phone shows while a photo is on its way — and, more importantly, what it shows when the
 * photo is going nowhere.
 *
 * Found on a real iPhone: the page worked and every photo sat at "Uploading 0%" indefinitely.
 * Uploads go straight to object storage on a different origin, and that origin was unreachable, so
 * nothing ever left the device. The queue could not tell that from a flaky network and retried in
 * silence. A screen that cannot send must say so.
 */
const item = (over: Partial<Parameters<typeof slotState>[1] & object> = {}) => ({
  id: 'i', scope: 's', slotKey: 'k', docType: 'id_front', contentType: 'image/jpeg',
  size: 1, sha256: 'x', status: 'queued', attempts: 0, nextAttemptAt: 0, bytes: null,
  ...over,
}) as NonNullable<Parameters<typeof slotState>[1]>;

describe('what the slot says', () => {
  it('shows progress while an upload is genuinely moving', () => {
    expect(slotState(undefined, item({ status: 'uploading' }), 0.4)).toEqual({ kind: 'uploading', progress: 0.4 });
  });

  it('says it is waiting when the phone is actually offline', () => {
    expect(slotState(undefined, item({ status: 'waiting_network' }), 0)).toEqual({ kind: 'waiting_network' });
  });

  it('keeps saying "uploading" for the first couple of failures — a blip is not worth alarming anyone', () => {
    expect(slotState(undefined, item({ attempts: 1, error: BLOCKED_MESSAGE }), 0)).toEqual({ kind: 'uploading', progress: 0 });
    expect(slotState(undefined, item({ attempts: 2, error: BLOCKED_MESSAGE }), 0)).toEqual({ kind: 'uploading', progress: 0 });
  });

  it('stops pretending once nothing has got through three times', () => {
    const state = slotState(undefined, item({ attempts: 3, error: BLOCKED_MESSAGE }), 0);
    expect(state).toEqual({ kind: 'blocked', message: BLOCKED_MESSAGE });
    // The message names the problem and where help is, rather than blaming the network.
    expect(BLOCKED_MESSAGE).toMatch(/Cannot reach the photo store/);
    expect(BLOCKED_MESSAGE).not.toMatch(/network/i);
  });

  it('does not confuse an ordinary retry message with being blocked', () => {
    expect(isBlocked({ attempts: 9, error: 'Upload link expired — renewing' })).toBe(false);
    expect(isBlocked({ attempts: 0, error: BLOCKED_MESSAGE })).toBe(false);
  });

  it('lets the server have the last word: verified beats anything the queue believes', () => {
    expect(slotState('verified', item({ attempts: 5, error: BLOCKED_MESSAGE }), 0)).toEqual({ kind: 'received' });
  });
});
