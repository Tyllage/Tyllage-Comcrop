/** Destructive helpers must never be enabled by the demo-seeding flag in production. */
export function assertNonProductionReset(nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv === 'production') throw new Error('Database reset and truncation are disabled in production.');
}

/** Fail before loading application modules or running any test setup. */
export function assertTestDatabase(testUrl, appUrl) {
  if (!testUrl) throw new Error('TEST_DATABASE_URL must point to a disposable database whose name ends in _test or starts with test_.');
  let target;
  try { target = new URL(testUrl); } catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.'); }
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !/^(?:test_.+|.+_test)$/.test(name)) {
    throw new Error('TEST_DATABASE_URL must use a disposable database name ending in _test or starting with test_.');
  }
  const identity = (url) => {
    const u = new URL(url);
    const host = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? 'loopback' : u.hostname;
    return `${host}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1))}`;
  };
  if (appUrl && identity(testUrl) === identity(appUrl)) {
    throw new Error('TEST_DATABASE_URL must not identify the application database. Use a separate disposable database.');
  }
}
