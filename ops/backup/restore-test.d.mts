/** Types for restore-test.mjs. */
export interface RestoreStep {
  step: 'download' | 'decrypt' | 'restore' | 'integrity' | 'counts';
  seconds?: number;
  [key: string]: unknown;
}

export interface RestoreReport {
  result: 'PASS' | 'FAIL';
  startedAt: string;
  totalSeconds: number;
  backup: { bucket: string; key: string; takenAt?: string; bytes: number };
  steps: RestoreStep[];
  /** One line per problem found in the restored database. Empty is a pass. */
  findings: string[];
  comparison: { differences: { key: string; live: unknown; restored: unknown }[]; live: Record<string, unknown> } | null;
}

export declare function runRestoreTest(options?: {
  privateKey?: string;
  passphrase?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle?: boolean;
  compareWith?: string;
  adminUrl?: string;
  prefix?: string;
  log?: (line: string) => void;
}): Promise<RestoreReport>;
