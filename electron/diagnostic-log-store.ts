import fs from 'node:fs/promises';
import path from 'node:path';

const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const ACTIVE_FILE_NAME = 'haptic-relay.jsonl';
const MAX_TEXT_LENGTH = 4096;

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export type DiagnosticEventInput = {
  timestamp: number;
  level: DiagnosticLevel;
  source: 'app' | 'hardware' | 'protection';
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

type MotionBucket = {
  second: number;
  attempted: number;
  completed: number;
  dropped: number;
  failed: number;
  firstTimestamp: number;
  lastTimestamp: number;
  lastCommand?: string;
  lastPosition?: number;
  lastIntensity?: number;
  lastFailureReason?: string;
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
  private motionBucket: MotionBucket | undefined;

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
    const second = Math.floor(sample.timestamp / 1000);
    if (this.motionBucket && this.motionBucket.second !== second) {
      const completedBucket = this.motionBucket;
      this.motionBucket = undefined;
      void this.recordMotionBucket(completedBucket);
    }

    const bucket = this.motionBucket ??= {
      second,
      attempted: 0,
      completed: 0,
      dropped: 0,
      failed: 0,
      firstTimestamp: sample.timestamp,
      lastTimestamp: sample.timestamp
    };

    bucket.attempted += 1;
    bucket[sample.outcome] += 1;
    bucket.lastTimestamp = sample.timestamp;
    if (sample.command !== undefined) bucket.lastCommand = boundedText(sample.command);
    if (sample.position !== undefined) bucket.lastPosition = sample.position;
    if (sample.intensity !== undefined) bucket.lastIntensity = sample.intensity;
    if (sample.reason !== undefined) bucket.lastFailureReason = boundedText(sample.reason);
  }

  async flushMotion() {
    const bucket = this.motionBucket;
    this.motionBucket = undefined;
    if (bucket) await this.recordMotionBucket(bucket);
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

  private recordMotionBucket(bucket: MotionBucket) {
    const data: Record<string, unknown> = {
      attempted: bucket.attempted,
      completed: bucket.completed,
      dropped: bucket.dropped,
      failed: bucket.failed,
      firstTimestamp: bucket.firstTimestamp,
      lastTimestamp: bucket.lastTimestamp
    };
    if (bucket.lastCommand !== undefined) data.lastCommand = bucket.lastCommand;
    if (bucket.lastPosition !== undefined) data.lastPosition = bucket.lastPosition;
    if (bucket.lastIntensity !== undefined) data.lastIntensity = bucket.lastIntensity;
    if (bucket.lastFailureReason !== undefined) data.lastFailureReason = bucket.lastFailureReason;

    return this.record({
      timestamp: bucket.lastTimestamp,
      level: bucket.failed > 0 ? 'error' : bucket.dropped > 0 ? 'warning' : 'info',
      source: 'hardware',
      event: 'hardware-motion-summary',
      data
    });
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
