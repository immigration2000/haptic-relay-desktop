import type { HardwareOutputLogAppend, HardwareOutputLogSession } from '../shared/protocol';

export type OutputLogEvent =
  | { type: 'reset'; session: HardwareOutputLogSession }
  | { type: 'append'; payload: HardwareOutputLogAppend };

export type OutputLogModel = {
  session: HardwareOutputLogSession;
  visibleCount: number;
  following: boolean;
  revision: number;
};

export const PAGE_SIZE: number;
export const MAX_ROWS: number;
export const MAX_RENDERED_ROWS: number;
export function createOutputLogModel(): OutputLogModel;
export function applyInitialSnapshot(model: OutputLogModel, snapshot: HardwareOutputLogSession, queuedEvents: OutputLogEvent[]): OutputLogModel;
export function reduceOutputLogEvent(model: OutputLogModel, event: OutputLogEvent): OutputLogModel;
export function getVisibleRows(model: OutputLogModel): HardwareOutputLogSession['rows'];
export function expandHistory(model: OutputLogModel, scrollTop: number, rowHeight: number): { model: OutputLogModel; scrollTop: number };
export function getVirtualWindow(totalRows: number, scrollTop: number, clientHeight: number, rowHeight: number): { start: number; end: number; topSpacerPx: number; bottomSpacerPx: number };
export function createFrameBatcher<T>(process: (values: T[]) => void, requestFrame: (callback: FrameRequestCallback) => number, cancelFrame: (handle: number) => void): { push(value: T): void; dispose(): void };
