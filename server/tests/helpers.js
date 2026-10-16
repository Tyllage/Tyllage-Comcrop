// Shared test setup. Tests run against a real PostgreSQL database (TEST_DATABASE_URL),
// which is wiped and re-seeded with the demo data before each test file.
// (Environment is prepared by tests/setup-env.js, preloaded via `node --import`.)
import { after } from 'node:test';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/config/db.js');
const { resetDatabase, runMigrations } = await import('../src/db/migrate.js');
const { seed, DEMO_PASSWORD } = await import('../src/seed/seed.js');

// Each test file runs in its own process; close the pool so it exits promptly.
after(() => pool.end());

export const app = createApp();
export const api = () => request(app);
export { pool, DEMO_PASSWORD };

export async function resetDb() {
  await resetDatabase();
  await runMigrations({ log: () => {} });
  await seed({ log: () => {} });
}

const tokenCache = new Map();
export async function login(email) {
  if (tokenCache.has(email)) return tokenCache.get(email);
  const res = await api().post('/api/auth/login').send({ email, password: DEMO_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const token = `Bearer ${res.body.data.token}`;
  tokenCache.set(email, token);
  return token;
}

/** Tokens survive a reseed because user ids are stable, but clear anyway between files. */
export function clearTokens() {
  tokenCache.clear();
}

export const ACCOUNTS = {
  platformAdmin: 'admin@tyllage.demo',
  farmAdmin: 'farmadmin@comcrop.demo',
  farmStaff: 'staff@comcrop.demo',
  farmBAdmin: 'farmb@tyllage.demo',
  restaurant: 'restaurant@tyllage.demo',
  hotel: 'hotel@tyllage.demo',
  consumer: 'consumer@tyllage.demo',
};

/** Looks up seeded records by natural keys so tests don't depend on serial ids. */
export async function ids() {
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const comcrop = await q(`SELECT id FROM farms WHERE slug = 'comcrop-singapore'`);
  const farmB = await q(`SELECT id FROM farms WHERE slug = 'farm-b'`);
  const batch = async (name) =>
    (await q(
      `SELECT hb.id FROM harvest_batches hb JOIN produce p ON p.id = hb.produce_id
        WHERE p.name = $1 AND hb.status <> 'CLOSED' ORDER BY hb.id LIMIT 1`,
      [name]
    )).id;
  return {
    comcrop: comcrop.id,
    farmB: farmB.id,
    kale: await batch('Kale'),
    basil: await batch('Sweet Basil'),
    naiBai: await batch('Nai Bai'),
    pakChoi: await batch('Pak Choi'),
    produce: async (name) => (await q('SELECT id FROM produce WHERE name = $1', [name])).id,
    buyer: async (name) => (await q('SELECT id FROM buyer_profiles WHERE organisation_name = $1', [name])).id,
  };
}

export async function batchStock(batchId) {
  const { rows } = await pool.query('SELECT * FROM batch_stock WHERE harvest_batch_id = $1', [batchId]);
  return rows[0];
}

/** Runs HarvestMatch on a batch and returns matches keyed by buyer name. */
export async function runMatch(batchId, token) {
  const res = await api().post(`/api/harvests/${batchId}/run-matching`).set('Authorization', token);
  if (res.status !== 200) throw new Error(`run-matching failed: ${JSON.stringify(res.body)}`);
  const byBuyer = Object.fromEntries(res.body.data.matches.map((m) => [m.buyerName, m]));
  return { ...res.body.data, byBuyer };
}

export const futureISO = (days) => new Date(Date.now() + days * 86400000).toISOString();
