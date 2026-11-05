// Minimal cookie jar for ONE origin (the portal). Honours Max-Age/Expires/deletion.
// Deliberately ignores Path, Domain, Secure and SameSite: we only ever talk to a single host.
export class CookieJar {
  #cookies = new Map();
  #now;

  constructor(now = () => Date.now()) {
    this.#now = now;
  }

  /** Stores every Set-Cookie header of a fetch Response. */
  store(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) this.#parse(line);
  }

  #parse(line) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq < 1) return;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    let expiresAt = null;
    let maxAge = null;
    for (const attr of attrs) {
      const [k, ...rest] = attr.split('=');
      const v = rest.join('=');
      if (k.toLowerCase() === 'max-age') maxAge = Number.parseInt(v, 10);
      if (k.toLowerCase() === 'expires' && !Number.isNaN(Date.parse(v))) expiresAt = Date.parse(v);
    }
    if (maxAge !== null && !Number.isNaN(maxAge)) expiresAt = this.#now() + maxAge * 1000; // Max-Age beats Expires
    if (value === '' || (expiresAt !== null && expiresAt <= this.#now())) this.#cookies.delete(name);
    else this.#cookies.set(name, { value, expiresAt });
  }

  #prune() {
    for (const [name, c] of this.#cookies) if (c.expiresAt !== null && c.expiresAt <= this.#now()) this.#cookies.delete(name);
  }

  header() {
    this.#prune();
    return [...this.#cookies].map(([name, c]) => `${name}=${c.value}`).join('; ');
  }

  get size() {
    this.#prune();
    return this.#cookies.size;
  }

  names() {
    this.#prune();
    return [...this.#cookies.keys()];
  }

  clear() {
    this.#cookies.clear();
  }
}
