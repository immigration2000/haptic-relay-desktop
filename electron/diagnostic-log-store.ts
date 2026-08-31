import fs from 'node:fs/promises';
import path from 'node:path';

const DIAGNOSTIC_SCHEMA_VERSION = 2 as const;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 16;
const ACTIVE_FILE_NAME = 'haptic-relay.jsonl';
const MAX_TEXT_LENGTH = 4096;

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export type DiagnosticEventInput = {
  timestamp: number;
  level: DiagnosticLevel;
  source: 'app' | 'hardware' | 'relay' | 'room' | 'protection';
  event: string;
  data: Record<string, unknown>;
};

export type MotionDiagnosticSample = {
  timestamp: number;
  outcome: 'completed' | 'dropped' | 'failed';
  command?: string;
  position?: number;
  intensity?: number;
  reason?: string;
  durationMs?: number;
  timeout?: boolean;
};

export interface DiagnosticFileOperations {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  stat(filePath: string): Promise<{ size: number }>;
  appendFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export type DiagnosticLogStoreOptions = {
  directory: string;
  sessionId: string;
  maxFileBytes?: number;
  maxFiles?: number;
  operations?: DiagnosticFileOperations;
  onError?: (error: Error) => void;
};

export class DiagnosticLogStore {
  private readonly directory: string;
  private readonly sessionId: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly operations: DiagnosticFileOperations;
  private readonly onError?: (error: Error) => void;
  private readonly activeFile: string;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disabled = false;
  private errorReported = false;

  constructor(options: DiagnosticLogStoreOptions) {
    this.directory = options.directory;
    this.sessionId = options.sessionId;
    this.maxFileBytes = normalizePositiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'max-file-bytes');
    this.maxFiles = normalizePositiveInteger(options.maxFiles, DEFAULT_MAX_FILES, 'max-files');
    this.operations = options.operations ?? fs;
    this.onError = options.onError;
    this.activeFile = path.join(this.directory, ACTIVE_FILE_NAME);
  }

  record(input: DiagnosticEventInput): Promise<void> {
    if (this.disabled) return Promise.resolve();

    const operation = this.queue.then(async () => {
      if (this.disabled) return;
      try {
        await this.appendRecord(input);
      } catch (error) {
        this.disable(error);
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  recordMotion(sample: MotionDiagnosticSample) {
    const data: Record<string, unknown> = { outcome: sample.outcome };
    if (sample.command !== undefined) data.command = boundedText(sample.command);
    if (sample.position !== undefined) data.position = sample.position;
    if (sample.intensity !== undefined) data.intensity = sample.intensity;
    if (sample.reason !== undefined) data.reason = boundedText(sample.reason);
    if (sample.durationMs !== undefined) data.durationMs = sample.durationMs;
    if (sample.timeout !== undefined) data.timeout = sample.timeout;
    return this.record({
      timestamp: sample.timestamp,
      level: sample.outcome === 'failed' ? 'error' : sample.outcome === 'dropped' ? 'warning' : 'info',
      source: 'hardware',
      event: 'hardware-motion-sample',
      data
    });
  }

  recordBoundary(input: DiagnosticEventInput) {
    return this.record(input);
  }

  flush() {
    return this.queue;
  }

  metadata() {
    return {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessionId: this.sessionId,
      format: 'jsonl' as const,
      activeFile: this.activeFile,
      maxFileBytes: this.maxFileBytes,
      maxFiles: this.maxFiles
    };
  }

  private async appendRecord(input: DiagnosticEventInput) {
    if (!this.initialized) {
      await this.operations.mkdir(this.directory, { recursive: true });
      this.initialized = true;
    }

    const record = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: input.timestamp,
      sessionId: this.sessionId,
      level: input.level,
      source: input.source,
      event: input.event,
      data: input.data
    };
    const line = `${JSON.stringify(record)}\n`;
    const currentSize = await this.fileSize(this.activeFile);
    if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > this.maxFileBytes) {
      await this.rotate();
    }
    await this.operations.appendFile(this.activeFile, line, 'utf8');
  }

  private async rotate() {
    if (this.maxFiles === 1) {
      await this.unlinkIfPresent(this.activeFile);
      return;
    }

    await this.unlinkIfPresent(this.rotatedPath(this.maxFiles - 1));
    for (let generation = this.maxFiles - 2; generation >= 1; generation -= 1) {
      await this.renameIfPresent(this.rotatedPath(generation), this.rotatedPath(generation + 1));
    }
    await this.renameIfPresent(this.activeFile, this.rotatedPath(1));
  }

  private rotatedPath(generation: number) {
    return path.join(this.directory, `haptic-relay.${generation}.jsonl`);
  }

  private async fileSize(filePath: string) {
    try {
      return (await this.operations.stat(filePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
  }

  private async unlinkIfPresent(filePath: string) {
    try {
      await this.operations.unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  private async renameIfPresent(sourcePath: string, targetPath: string) {
    try {
      await this.operations.rename(sourcePath, targetPath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  private disable(error: unknown) {
    this.disabled = true;
    if (this.errorReported) return;
    this.errorReported = true;
    const normalized = error instanceof Error ? error : new Error('diagnostic-log-failed');
    try {
      this.onError?.(normalized);
    } catch {
      // A diagnostic error callback must not escape into application work.
    }
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error(`invalid-diagnostic-${field}`);
  return normalized;
}

function boundedText(value: string) {
  return value.slice(0, MAX_TEXT_LENGTH);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
