/** Types for backup.mjs. */
export interface BackupResult {
  key: string;
  bucket: string;
  sha256: string;
  plainBytes: number;
  sealedBytes: number;
  retainUntil: Date;
}

export declare function backupKey(at?: Date): string;
export declare function takeBackup(options?: {
  databaseUrl?: string;
  publicKey?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  retentionDays?: number;
  forcePathStyle?: boolean;
  now?: Date;
  log?: (line: string) => void;
}): Promise<BackupResult>;
