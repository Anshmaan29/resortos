import { isBlocked, type QueueItem } from './upload-queue';

/**
 * What a document slot shows, derived from the local queue and the server's view of the document.
 *
 * Plain logic, deliberately out of the component file: it is the part worth testing on its own, and
 * what it gets wrong — claiming "Uploading 0%" while nothing is being sent — is invisible in a
 * screenshot but obvious in a test.
 */
export type SlotState =
  | { kind: 'empty' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'waiting_network' }
  | { kind: 'blocked'; message: string }
  | { kind: 'verifying' }
  | { kind: 'received' }
  | { kind: 'failed'; message: string };

/** Local queue state wins while an upload is in flight; the server's verified status is final. */
export function slotState(serverStatus: 'pending' | 'verified' | 'failed' | 'orphaned' | undefined, item: QueueItem | undefined, progress: number): SlotState {
  if (serverStatus === 'verified' || item?.status === 'done') return { kind: 'received' };
  if (item?.status === 'failed') return { kind: 'failed', message: item.error ?? 'Upload failed' };
  if (item?.status === 'waiting_network') return { kind: 'waiting_network' };
  // Still trying, but nothing is getting through. Say that, rather than "Uploading 0%" for ever.
  if (item && isBlocked(item)) return { kind: 'blocked', message: item.error! };
  if (item?.status === 'verifying') return { kind: 'verifying' };
  if (item && (item.status === 'uploading' || item.status === 'queued')) return { kind: 'uploading', progress };
  if (serverStatus === 'pending') return { kind: 'verifying' };
  if (serverStatus === 'failed') return { kind: 'failed', message: 'Upload failed — capture it again' };
  return { kind: 'empty' };
}
