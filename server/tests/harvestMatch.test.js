import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCandidate,
  scorePrice,
  scoreDate,
  scoreProduce,
  scoreReliability,
  rankAndAllocate,
  effectiveRequiredDate,
} from '../src/services/harvestMatchService.js';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch } from './helpers.js';

const batch = {
  id: 1, farm_id: 1, produce_id: 10, produce_name: 'Kale', unit: 'kg', harvest_date: '2030-01-10',
  min_price: 10, preferred_price: 14, farm_region: 'NORTH', fulfilment_methods: ['FARM_PICKUP', 'DELIVERY'], remaining_quantity: 46,
};
const demand = (o = {}) => ({
  id: 1, buyer_id: 1, produce_id: 10, produce_name: 'Kale', quantity: 15, fulfilled_quantity: 0, required_date: '2030-01-11',
  max_price: 14, recurrence: 'NONE', region: 'NORTH', preferred_collection_method: 'DELIVERY', organisation_name: 'R', buyer_type: 'RESTAURANT', ...o,
});

describe('HarvestMatch scoring (unit)', () => {
  it('scores a perfect candidate 100 with explainable reasons', () => {
    const r = scoreCandidate(batch, demand(), { supplyRemaining: 46, reliability: { completed: 4, total: 4 } });
    assert.equal(r.excluded, false);
    assert.equal(r.matchScore, 100);
    assert.ok(r.reasons.includes('Exact produce match'));
    assert.ok(r.reasons.includes('Required date matches harvest window'));
    assert.ok(r.reasons.includes('Requested quantity fits available supply'));
    assert.equal(r.unitPrice, 14);
  });

  it('weights sum to the total score', () => {
    const r = scoreCandidate(batch, demand({ max_price: 12, required_date: '2030-01-13' }), { supplyRemaining: 46, reliability: null });
    const sum = Object.values(r.breakdown).reduce((s, f) => s + f.contribution, 0);
    assert.equal(Math.round(sum), r.matchScore);
  });

  it('rejects an incompatible price (buyer max below farm minimum)', () => {
    const p = scorePrice(batch, demand({ max_price: 8 }));
    assert.match(p.exclude, /below farm minimum/);
    const r = scoreCandidate(batch, demand({ max_price: 8 }), { supplyRemaining: 46 });
    assert.equal(r.excluded, true);
  });

  it('interpolates price score between minimum and preferred, using buyer price', () => {
    const p = scorePrice(batch, demand({ max_price: 12 }));
    assert.equal(p.score, 75);
    assert.equal(p.unitPrice, 12);
    assert.equal(scorePrice(batch, demand({ max_price: null })).score, 70);
  });

  it('excludes demand needed before harvest or beyond the freshness window', () => {
    assert.match(scoreDate(batch, demand({ required_date: '2030-01-09' })).exclude, /before harvest/);
    assert.match(scoreDate(batch, demand({ required_date: '2030-01-20' })).exclude, /freshness window/);
  });

  it('rolls recurring demand forward to the next occurrence', () => {
    assert.equal(effectiveRequiredDate({ recurrence: 'WEEKLY', required_date: '2030-01-04' }, '2030-01-10'), '2030-01-11');
    assert.equal(effectiveRequiredDate({ recurrence: 'NONE', required_date: '2030-01-04' }, '2030-01-10'), '2030-01-04');
  });

  it('matches close produce names but not unrelated produce', () => {
    assert.equal(scoreProduce(batch, demand({ produce_id: null, produce_name: 'Baby Kale' })).score, 75);
    assert.equal(scoreProduce(batch, demand({ produce_id: null, produce_name: 'Mint' })).exclude, 'Different produce');
  });

  it('uses a neutral reliability score when history is insufficient', () => {
    const r = scoreReliability(null);
    assert.equal(r.score, 60);
    assert.match(r.reason, /neutral/);
    assert.equal(scoreReliability({ completed: 1, total: 2 }).score, 50);
  });

  it('never recommends more than the available supply in total', () => {
    const cands = [
      demand({ id: 1, quantity: 30 }),
      demand({ id: 2, quantity: 30, max_price: 13 }),
      demand({ id: 3, quantity: 30, max_price: 12 }),
    ];
    const { matches, excluded, unmatchedQuantity } = rankAndAllocate(batch, cands, {});
    const total = matches.reduce((s, m) => s + m.recommendedQuantity, 0);
    assert.equal(total, 46);
    assert.equal(unmatchedQuantity, 0);
    assert.deepEqual(matches.map((m) => m.recommendedQuantity), [30, 16]);
    assert.ok(excluded.some((e) => /No supply left/.test(e.reason)));
  });
});

describe('HarvestMatch on the ComCrop demo Kale batch (integration)', () => {
  let I;
  let admin;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
  });
  after(clearTokens);

  it('ranks demand, explains each recommendation and reports exclusions', async () => {
    const r = await runMatch(I.kale, admin);
    assert.equal(r.batch.unallocatedQuantity, 46);
    const names = r.matches.map((m) => m.buyerName);
    assert.deepEqual(names.slice(0, 3), ['Restaurant A', 'Hotel B', 'Community Buyer C']);
    const scores = r.matches.map((m) => m.matchScore);
    assert.deepEqual([...scores].sort((a, b) => b - a), scores);
    for (const m of r.matches) {
      assert.ok(m.reasons.length > 0);
      assert.equal(m.status, 'SUGGESTED');
      assert.equal(m.expectedRevenue, Math.round(m.recommendedQuantity * m.unitPrice * 100) / 100);
    }
    const total = r.matches.reduce((s, m) => s + m.recommendedQuantity, 0);
    assert.ok(total <= 46);

    const reasons = r.run.excluded.map((e) => `${e.buyerName}: ${e.reason}`);
    assert.ok(reasons.some((x) => x.startsWith('Caterer E: Buyer max price')), reasons.join('; '));
    assert.ok(reasons.some((x) => x === 'Wholesaler H: Buyer cancelled an order for this batch'), reasons.join('; '));
  });

  it('re-running supersedes earlier unactioned suggestions', async () => {
    await runMatch(I.kale, admin);
    const second = await runMatch(I.kale, admin);
    const suggested = second.matches.filter((m) => m.status === 'SUGGESTED');
    assert.equal(suggested.length, second.run.candidatesCount);
  });
});
