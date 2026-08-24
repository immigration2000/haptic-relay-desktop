import type { AppLogEntry } from './protocol.js';

type DiagnosticLogMetadata = {
  schemaVersion: number;
  sessionId: string;
  format: 'jsonl';
  activeFile: string;
  maxFileBytes: number;
  maxFiles: number;
};

type LogExportInput = {
  appName: string;
  version: string;
  exportedAt: string;
  entries: AppLogEntry[];
  diagnostic?: DiagnosticLogMetadata;
};

export function buildLogExportPayload(input: LogExportInput) {
  return {
    schemaVersion: 1,
    sessionId: input.diagnostic?.sessionId ?? null,
    app: input.appName,
    version: input.version,
    exportedAt: input.exportedAt,
    entries: input.entries,
    diagnosticLog: input.diagnostic ? {
      schemaVersion: input.diagnostic.schemaVersion,
      sessionId: input.diagnostic.sessionId,
      format: input.diagnostic.format,
      activeFile: input.diagnostic.activeFile,
      maxFileBytes: input.diagnostic.maxFileBytes,
      maxFiles: input.diagnostic.maxFiles
    } : null
  };
}
