export const PAGE_SIZE = 500;
export const MAX_ROWS = 10_000;
export const MAX_RENDERED_ROWS = 80;
const VIRTUAL_OVERSCAN_ROWS = 8;

const EMPTY_SESSION = { sessionId: 0, rows: [], omittedRows: 0 };

export function createOutputLogModel() {
  return { session: EMPTY_SESSION, visibleCount: PAGE_SIZE, following: true, revision: 0 };
}

export function applyInitialSnapshot(model, snapshot, queuedEvents) {
  const initial = {
    ...model,
    session: retainSession(snapshot),
    visibleCount: PAGE_SIZE,
    revision: model.revision + 1
  };
  return queuedEvents.reduce(reduceOutputLogEvent, initial);
}

export function reduceOutputLogEvent(model, event) {
  if (event.type === 'reset') {
    if (event.session.sessionId < model.session.sessionId) return model;
    return {
      ...model,
      session: retainSession(event.session),
      visibleCount: PAGE_SIZE,
      following: true,
      revision: model.revision + 1
    };
  }

  const { payload } = event;
  if (payload.sessionId < model.session.sessionId) return model;
  if (payload.sessionId > model.session.sessionId) {
    return {
      ...model,
      session: { sessionId: payload.sessionId, rows: [payload.row], omittedRows: payload.omittedRows },
      visibleCount: PAGE_SIZE,
      following: true,
      revision: model.revision + 1
    };
  }
  if (model.session.rows.some(row => row.id === payload.row.id)) return model;

  return {
    ...model,
    session: {
      ...model.session,
      rows: [...model.session.rows, payload.row].slice(-MAX_ROWS),
      omittedRows: payload.omittedRows
    },
    revision: model.revision + 1
  };
}

export function getVisibleRows(model) {
  return model.session.rows.slice(Math.max(0, model.session.rows.length - model.visibleCount));
}

export function expandHistory(model, scrollTop, rowHeight) {
  const visibleCount = Math.min(model.session.rows.length, model.visibleCount + PAGE_SIZE);
  const addedRows = visibleCount - model.visibleCount;
  if (addedRows <= 0) return { model, scrollTop };
  return {
    model: { ...model, visibleCount, following: false },
    scrollTop: scrollTop + addedRows * rowHeight
  };
}

export function getVirtualWindow(totalRows, scrollTop, clientHeight, rowHeight) {
  const safeRowHeight = Math.max(1, rowHeight);
  const viewportRows = Math.max(1, Math.ceil(Math.max(0, clientHeight) / safeRowHeight));
  const count = Math.min(MAX_RENDERED_ROWS, viewportRows + VIRTUAL_OVERSCAN_ROWS * 2, totalRows);
  const desiredStart = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeRowHeight) - VIRTUAL_OVERSCAN_ROWS);
  const start = Math.min(desiredStart, Math.max(0, totalRows - count));
  const end = start + count;
  return {
    start,
    end,
    topSpacerPx: start * safeRowHeight,
    bottomSpacerPx: (totalRows - end) * safeRowHeight
  };
}

export function createFrameBatcher(process, requestFrame, cancelFrame) {
  let handle;
  let queued = [];
  let disposed = false;

  return {
    push(value) {
      if (disposed) return;
      queued.push(value);
      if (handle !== undefined) return;
      handle = requestFrame(() => {
        handle = undefined;
        if (disposed) return;
        const values = queued;
        queued = [];
        process(values);
      });
    },
    dispose() {
      disposed = true;
      queued = [];
      if (handle !== undefined) cancelFrame(handle);
      handle = undefined;
    }
  };
}

function retainSession(session) {
  return { ...session, rows: session.rows.slice(-MAX_ROWS) };
}
