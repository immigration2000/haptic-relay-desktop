export const PAGE_SIZE = 500;
export const MAX_ROWS = 10_000;
export const MAX_RENDERED_ROWS = 80;
const VIRTUAL_OVERSCAN_ROWS = 8;

const EMPTY_SESSION = { sessionId: 0, rows: [], omittedRows: 0 };

export function createOutputLogModel() {
  return { session: EMPTY_SESSION, visibleCount: PAGE_SIZE, following: true, anchorRowId: undefined, revision: 0 };
}

export function applyInitialSnapshot(model, snapshot, queuedEvents) {
  const initial = {
    ...model,
    session: retainSession(snapshot),
    visibleCount: PAGE_SIZE,
    following: true,
    anchorRowId: undefined,
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
      anchorRowId: undefined,
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
      anchorRowId: undefined,
      revision: model.revision + 1
    };
  }
  if (model.session.rows.some(row => row.id === payload.row.id)) return model;

  const rows = [...model.session.rows, payload.row].slice(-MAX_ROWS);
  return {
    ...model,
    session: {
      ...model.session,
      rows,
      omittedRows: payload.omittedRows
    },
    anchorRowId: model.following ? undefined : resolveAnchorRowId(model.anchorRowId, rows),
    revision: model.revision + 1
  };
}

export function getVisibleRows(model) {
  const { rows } = model.session;
  if (model.following) return rows.slice(Math.max(0, rows.length - model.visibleCount));
  const anchorIndex = getAnchorIndex(model, rows);
  return rows.slice(anchorIndex, anchorIndex + model.visibleCount);
}

export function setOutputLogFollowing(model, following) {
  if (following) {
    if (model.following && model.anchorRowId === undefined) return model;
    return { ...model, following: true, anchorRowId: undefined };
  }
  const anchorRowId = getVisibleRows(model)[0]?.id;
  if (!model.following && model.anchorRowId === anchorRowId) return model;
  return { ...model, following: false, anchorRowId };
}

export function expandHistory(model, scrollTop, rowHeight) {
  const selectedRows = getVisibleRows(model);
  const anchorIndex = model.following
    ? Math.max(0, model.session.rows.length - selectedRows.length)
    : getAnchorIndex(model, model.session.rows);
  const addedRows = Math.min(PAGE_SIZE, anchorIndex);
  if (addedRows <= 0) return { model, scrollTop };
  const nextAnchorRowId = model.session.rows[anchorIndex - addedRows]?.id;
  return {
    model: {
      ...model,
      visibleCount: selectedRows.length + addedRows,
      following: false,
      anchorRowId: nextAnchorRowId
    },
    scrollTop: scrollTop + addedRows * rowHeight
  };
}

export function canExpandHistory(model) {
  if (model.session.rows.length === 0) return false;
  if (model.following) return model.session.rows.length > getVisibleRows(model).length;
  return getAnchorIndex(model, model.session.rows) > 0;
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

function getAnchorIndex(model, rows) {
  if (rows.length === 0) return 0;
  const index = model.anchorRowId === undefined ? -1 : rows.findIndex(row => row.id === model.anchorRowId);
  return index >= 0 ? index : 0;
}

function resolveAnchorRowId(anchorRowId, rows) {
  if (anchorRowId !== undefined && rows.some(row => row.id === anchorRowId)) return anchorRowId;
  return rows[0]?.id;
}
