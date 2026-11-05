export const Status = ({ value }) => <span className={`pill status-${value}`}>{value}</span>;

export function Loading({ what = 'Loading' }) {
  return <p className="muted">{what}…</p>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <strong>{error.code ?? 'error'}</strong> {error.message}
    </div>
  );
}

export function Pager({ page, onChange }) {
  const { limit, offset, total } = page;
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  return (
    <div className="pager">
      <button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>← Prev</button>
      <span className="muted">{from}–{to} of {total}</span>
      <button disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next →</button>
    </div>
  );
}
