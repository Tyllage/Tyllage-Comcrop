import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch } from './helpers.js';

describe('RBAC and farm access control', () => {
  let I;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
  });
  after(clearTokens);

  it('buyers cannot access farm-side endpoints', async () => {
    const consumer = await login(ACCOUNTS.consumer);
    assert.equal((await api().get(`/api/harvests?farmId=${I.comcrop}`).set('Authorization', consumer)).status, 403);
    assert.equal((await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', consumer)).status, 403);
    assert.equal((await api().post(`/api/harvests/${I.kale}/run-matching`).set('Authorization', consumer)).status, 403);
    const restaurant = await login(ACCOUNTS.restaurant);
    assert.equal((await api().get(`/api/analytics?farmId=${I.comcrop}`).set('Authorization', restaurant)).status, 403);
  });

  it('farm staff can manage harvests but cannot run HarvestMatch, approve, or change prices', async () => {
    const staff = await login(ACCOUNTS.farmStaff);
    const list = await api().get(`/api/harvests?farmId=${I.comcrop}`).set('Authorization', staff);
    assert.equal(list.status, 200);
    assert.equal((await api().post(`/api/harvests/${I.kale}/run-matching`).set('Authorization', staff)).status, 403);
    const price = await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', staff).send({ preferredPrice: 20 });
    assert.equal(price.status, 403);
    const qty = await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', staff).send({ actualQuantity: 61 });
    assert.equal(qty.status, 200);
    assert.equal(qty.body.data.actualQuantity, 61);

    const admin = await login(ACCOUNTS.farmAdmin);
    const { matches } = await runMatch(I.kale, admin);
    assert.equal((await api().post(`/api/matches/${matches[0].id}/approve`).set('Authorization', staff).send({})).status, 403);
  });

  it("another farm's admin cannot read or act on ComCrop records", async () => {
    const farmB = await login(ACCOUNTS.farmBAdmin);
    const dash = await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', farmB);
    assert.equal(dash.status, 403);
    assert.equal(dash.body.code, 'FARM_ACCESS_DENIED');
    assert.equal((await api().get(`/api/harvests/${I.kale}`).set('Authorization', farmB)).status, 403);
    assert.equal((await api().get(`/api/harvests/${I.kale}/matches`).set('Authorization', farmB)).status, 403);
    assert.equal((await api().patch(`/api/harvests/${I.kale}`).set('Authorization', farmB).send({ notes: 'x' })).status, 403);
    assert.equal((await api().get(`/api/orders?farmId=${I.comcrop}`).set('Authorization', farmB)).status, 403);
    // Their own farm works.
    assert.equal((await api().get(`/api/farms/${I.farmB}/dashboard`).set('Authorization', farmB)).status, 200);
  });

  it('never trusts a client-supplied farmId', async () => {
    const admin = await login(ACCOUNTS.farmAdmin);
    const pakChoi = await (await ids()).produce('Pak Choi');
    // Creating a harvest on another farm is denied.
    const other = await api().post('/api/harvests').set('Authorization', admin).send({
      farmId: I.farmB, produceId: pakChoi, expectedQuantity: 10, harvestDate: '2099-01-01', preferredPrice: 9, minPrice: 7,
    });
    assert.equal(other.status, 403);
    // Using another farm's produce on our farm is rejected.
    const mismatch = await api().post('/api/harvests').set('Authorization', admin).send({
      farmId: I.comcrop, produceId: pakChoi, expectedQuantity: 10, harvestDate: '2099-01-01', preferredPrice: 9, minPrice: 7,
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, 'PRODUCE_FARM_MISMATCH');
  });

  it('platform admin can access every farm; only platform admin manages users', async () => {
    const admin = await login(ACCOUNTS.platformAdmin);
    assert.equal((await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', admin)).status, 200);
    assert.equal((await api().get(`/api/farms/${I.farmB}/dashboard`).set('Authorization', admin)).status, 200);
    const farmAdmin = await login(ACCOUNTS.farmAdmin);
    assert.equal((await api().get('/api/users').set('Authorization', farmAdmin)).status, 403);
    assert.equal((await api().post('/api/farms').set('Authorization', farmAdmin).send({ name: 'X', slug: 'xxx' })).status, 403);
  });

  it('buyers only see their own orders', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const hotel = await login(ACCOUNTS.hotel);
    const mine = await api().get('/api/orders').set('Authorization', restaurant);
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.length > 0);
    assert.ok(mine.body.data.every((o) => o.buyerName === 'Restaurant A'));
    const orderId = mine.body.data[0].id;
    assert.equal((await api().get(`/api/orders/${orderId}`).set('Authorization', hotel)).status, 403);
    const cancel = await api().patch(`/api/orders/${orderId}/status`).set('Authorization', hotel).send({ status: 'CANCELLED' });
    assert.equal(cancel.status, 403);
  });

  it('public endpoints never expose farm minimum prices', async () => {
    const supply = await api().get('/api/marketplace/supply');
    assert.equal(supply.status, 200);
    const all = [...supply.body.data.availableNow, ...supply.body.data.growingSoon];
    assert.ok(all.length > 0);
    for (const b of all) {
      assert.equal(b.minPrice, undefined);
      assert.equal(b.notes, undefined);
    }
  });
});
