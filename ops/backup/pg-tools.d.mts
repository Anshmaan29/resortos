/** Types for pg-tools.mjs. */
export declare function pgToolStrategy(): 'native' | 'compose';
export declare function runPgTool(
  tool: 'pg_dump' | 'pg_restore' | 'psql',
  args: string[],
  options?: { url?: string; stdin?: string | Buffer; cwd?: string },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }>;
