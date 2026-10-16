import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch } from './helpers.js';
import { buildRecoverySuggestions } from '../src/services/recoveryService.js';

describe('Demand Recovery — full demo story', () => {
  let I;
  let admin;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
  });
  after(clearTokens);

  it('Kale starts HIGH risk and is listed as a recovery candidate', async () => {
    const dash = await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', admin);
    const kale = dash.body.data.upcomingHarvest.find((b) => b.id === I.kale);
    assert.equal(kale.demandCoverage, 34.3);
    assert.equal(kale.riskLevel, 'HIGH');
    assert.equal(kale.unallocatedQuantity, 46);
    assert.equal(kale.status, 'AT_RISK');
    const candidates = await api().get(`/api/recovery?farmId=${I.comcrop}`).set('Authorization', admin);
    const k = candidates.body.data.find((c) => c.id === I.kale);
    assert.ok(k.triggers.some((t) => t.code === 'BUYER_CANCELLED'));
    assert.ok(k.triggers.some((t) => t.code === 'LOW_COVERAGE'));
  });

  it('after approving the top three matches 5kg remains and recovery recommends Rescue', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    for (const name of ['Restaurant A', 'Hotel B', 'Community Buyer C']) {
      const r = await api().post(`/api/matches/${byBuyer[name].id}/approve`).set('Authorization', admin).send({});
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const rec = await api().post(`/api/recovery/harvests/${I.kale}/start`).set('Authorization', admin).send({ trigger: 'MANUAL' });
    assert.equal(rec.status, 200);
    const { recovery, batch } = rec.body.data;
    assert.equal(batch.confirmedDemand, 65);
    assert.equal(batch.unallocatedQuantity, 5);
    assert.equal(recovery.remainingAtStart, 5);
    assert.equal(recovery.potentialStrongTotal, 0);
    assert.deepEqual(recovery.suggestions.map((s) => [s.type, s.quantity]), [['MOVE_TO_RESCUE', 5]]);
  });

  it('recovery excludes cancelled buyers, rejected matches, fulfilled and cancelled demand', async () => {
    const rec = await api().post(`/api/recovery/harvests/${I.kale}/start`).set('Authorization', admin).send({});
    const { matches, run } = rec.body.data;
    const suggested = matches.filter((m) => m.status === 'SUGGESTED').map((m) => m.buyerName);
    // Fulfilled demand (approved buyers) is not re-offered.
    for (const name of ['Restaurant A', 'Hotel B', 'Community Buyer C']) assert.ok(!suggested.includes(name), name);
    // Buyer who cancelled on this batch is excluded with a reason.
    assert.ok(run.excluded.some((e) => e.buyerName === 'Wholesaler H' && /cancelled/.test(e.reason)));

    // Reject Consumer G's weak suggestion, then cancel Caterer E's demand: neither may come back.
    const consumerG = matches.find((m) => m.buyerName === 'Consumer G' && m.status === 'SUGGESTED');
    await api().post(`/api/matches/${consumerG.id}/reject`).set('Authorization', admin).send({ reason: 'Too far' }).expect(200);
    const caterer = (await api().get(`/api/demand?farmId=${I.comcrop}`).set('Authorization', admin)).body.data
      .find((d) => d.buyerName === 'Caterer E' && d.produceName === 'Kale');
    await api().post(`/api/demand/${caterer.id}/cancel`).set('Authorization', admin).expect(200);

    const again = await api().post(`/api/recovery/harvests/${I.kale}/start`).set('Authorization', admin).send({});
    const ex = again.body.data.run.excluded;
    assert.ok(ex.some((e) => e.buyerName === 'Consumer G' && /Previously rejected/.test(e.reason)));
    assert.ok(!again.body.data.matches.some((m) => m.status === 'SUGGESTED'));
    assert.ok(!ex.some((e) => e.buyerName === 'Caterer E'), 'cancelled demand is not even considered');
  });

  it('suggestions never execute anything automatically', async () => {
    const before = (await api().get(`/api/harvests/${I.kale}`).set('Authorization', admin)).body.data;
    assert.equal(before.rescueQuantity, 0);
    assert.equal(before.unallocatedQuantity, 5);
  });

  it('builds suggestions from a run summary', () => {
    const s = buildRecoverySuggestions({ potentialStrongTotal: 15, remainingAfterStrong: 5 });
    assert.deepEqual(s.map((x) => x.type), ['APPROVE_MATCHES', 'MOVE_TO_RESCUE']);
    assert.equal(buildRecoverySuggestions({ potentialStrongTotal: 0, remainingAfterStrong: 0 })[0].type, 'NONE');
  });
});
