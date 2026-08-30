import type {
  HardwareOutputLogRow,
  HardwareOutputLogSession,
  HardwareOutputSnapshot
} from '../protocol.js';

export const MAX_HARDWARE_OUTPUT_LOG_ROWS = 10_000;

export class HardwareOutputSessionStore {
  private sessionId = 0;
  private nextRowId = 1;
  private startedAt: number | undefined;
  private portPath: string | undefined;
  private rows: HardwareOutputLogRow[] = [];
  private omittedRows = 0;

  constructor(
    private readonly maxRows = MAX_HARDWARE_OUTPUT_LOG_ROWS,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error('invalid-hardware-output-log-limit');
  }

  reset(portPath: string) {
    this.sessionId += 1;
    this.nextRowId = 1;
    this.startedAt = this.now();
    this.portPath = portPath;
    this.rows = [];
    this.omittedRows = 0;
    return this.snapshot();
  }

  append(snapshot: HardwareOutputSnapshot) {
    const row: HardwareOutputLogRow = { id: this.nextRowId++, ...snapshot };
    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      const excess = this.rows.length - this.maxRows;
      this.rows.splice(0, excess);
      this.omittedRows += excess;
    }
    return { row: { ...row }, omittedRows: this.omittedRows };
  }

  snapshot(): HardwareOutputLogSession {
    return {
      sessionId: this.sessionId,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.portPath === undefined ? {} : { portPath: this.portPath }),
      rows: this.rows.map(row => ({ ...row })),
      omittedRows: this.omittedRows
    };
  }
}
