// Tiny structured logger (JSON lines) so we don't need a dependency.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level = 'info', sink = console.log) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, extra = {}) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...extra }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
