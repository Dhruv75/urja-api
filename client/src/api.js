import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, params = {}, init) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const res = await fetch(`/api/v1${path}${qs ? `?${qs}` : ''}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText);
  return body;
}

/** Fetches on mount and whenever path/params change; `reload()` forces a refetch. */
export function useApi(path, params = {}, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify([path, params, tick]);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path, params)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error) => !cancelled && setState({ data: null, error, loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export const ISSUE_LABELS = {
  orphan_node: 'Node whose parent does not exist',
  cycle: 'Parent cycle (broken automatically)',
  self_parent: 'Node that is its own parent',
  duplicate_node: 'Node listed twice',
  duplicate_node_conflict: 'Node listed twice with different parents',
  reference_mismatch: 'Parent reference matched only after ignoring case/whitespace',
  meter_no_parent: 'Meter without a parent node',
  meter_unknown_parent: 'Meter whose parent node does not exist',
  duplicate_meter: 'Meter listed twice',
  no_location: 'Meter without coordinates',
  invalid_location: 'Meter with unusable coordinates',
  missing_id: 'Record without an id',
};

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const fmtAge = (sec) => (sec == null ? '–' : sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 129_600 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86_400)} d`);
