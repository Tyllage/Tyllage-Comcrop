import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, pool, resetDb, login, clearTokens, ACCOUNTS, ids, batchStock } from './helpers.js';

describe('Tyllage Shop and harvest rewards', () => {
  let I;
  let admin;
  let consumer;
  const offers = {};
  const points = async () => (await api().get(`/api/shop/rewards/${I.comcrop}`).set('Authorization', consumer)).body.data.points;
  const setStatus = (id, status, token = admin, reason) =>
    api().patch(`/api/orders/${id}/status`).set('Authorization', token).send({ status, reason });

  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
    consumer = await login(ACCOUNTS.consumer);
    const res = await api().get(`/api/shop/farms/${I.comcrop}`);
    for (const l of res.body.data) offers[l.kind] = l;
  });
  after(clearTokens);

  it('lists the seeded farm-approved offers publicly without costs or override reasons', async () => {
    const res = await api().get(`/api/shop/farms/${I.comcrop}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((l) => l.kind).sort(), ['PREORDER', 'REWARD', 'SURPRISE_BAG']);
    for (const l of res.body.data) {
      assert.equal(l.packagingCost, undefined);
      assert.equal(l.marginOverrideReason, undefined);
    }
  });

  it('publishing requires farm approval, a farm admin and enough unallocated harvest', async () => {
    const body = {
      harvestBatchId: I.kale, title: 'Kale bunch', kind: 'PREORDER', quantityPerPack: 1, packPrice: 14, originalValue: 14,
      maxPacks: 5, pickupDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), pickupStart: '10:00', pickupEnd: '12:00',
    };
    const staff = await login(ACCOUNTS.farmStaff);
    assert.equal((await api().post('/api/shop/listings').set('Authorization', admin).send({ ...body, farmId: I.comcrop })).status, 400);
    assert.equal((await api().post('/api/shop/listings').set('Authorization', staff).send({ ...body, farmId: I.comcrop, farmApproved: true })).status, 403);
    const over = await api().post('/api/shop/listings').set('Authorization', admin).send({ ...body, farmId: I.comcrop, farmApproved: true, maxPacks: 1000 });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'OVER_ALLOCATION');
    const ok = await api().post('/api/shop/listings').set('Authorization', admin).send({ ...body, farmId: I.comcrop, farmApproved: true });
    assert.equal(ok.status, 201);
  });

  it('only consumers can check out, and the simulated payment must be acknowledged', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const url = `/api/shop/listings/${offers.SURPRISE_BAG.id}/checkout`;
    assert.equal((await api().post(url).set('Authorization', restaurant).send({ packs: 1, acceptDemoPayment: true })).status, 403);
    assert.equal((await api().post(url).set('Authorization', consumer).send({ packs: 1 })).status, 400);
  });

  it('checkout reserves harvest stock and rejects invalid point redemptions', async () => {
    const url = `/api/shop/listings/${offers.SURPRISE_BAG.id}/checkout`;
    assert.equal((await api().post(url).set('Authorization', consumer).send({ packs: 1, redeemPoints: 50, acceptDemoPayment: true })).status, 400);
    const short = await api().post(url).set('Authorization', consumer).send({ packs: 1, redeemPoints: 100, acceptDemoPayment: true });
    assert.equal(short.status, 409);
    assert.equal(short.body.code, 'INSUFFICIENT_POINTS');
    const tooMany = await api().post(url).set('Authorization', consumer).send({ packs: offers.SURPRISE_BAG.maxPacks + 1, acceptDemoPayment: true });
    assert.equal(tooMany.status, 409);

    const before = await batchStock(I.kale);
    const res = await api().post(url).set('Authorization', consumer).send({ packs: 2, acceptDemoPayment: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.totalAmount, 20);
    assert.equal(res.body.data.paymentStatus, 'DEMO_PAID');
    assert.equal((await batchStock(I.kale)).remaining_quantity, before.remaining_quantity - 2);
  });

  it('redeems a reward with points and restores them when the order is cancelled', async () => {
    assert.equal(await points(), 28);
    const res = await api().post(`/api/shop/listings/${offers.REWARD.id}/checkout`).set('Authorization', consumer).send({ packs: 1, acceptDemoPayment: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.pointsRedeemed, 25);
    assert.equal(res.body.data.paymentStatus, 'NO_PAYMENT');
    assert.equal(await points(), 3);

    assert.equal((await setStatus(res.body.data.id, 'CANCELLED', consumer)).status, 200);
    assert.equal(await points(), 28);
    const listing = (await api().get(`/api/shop/farms/${I.comcrop}`)).body.data.find((l) => l.id === offers.REWARD.id);
    assert.equal(listing.availablePacks, offers.REWARD.availablePacks);
  });

  it('earns one point per whole dollar once a Shop order is collected', async () => {
    const res = await api().post(`/api/shop/listings/${offers.SURPRISE_BAG.id}/checkout`).set('Authorization', consumer).send({ packs: 1, acceptDemoPayment: true });
    const id = res.body.data.id;
    assert.equal((await setStatus(id, 'READY')).status, 200);
    const early = await setStatus(id, 'COMPLETED');
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'PICKUP_NOT_STARTED');

    // Move the pickup window into the past so collection can be recorded.
    await pool.query("UPDATE shop_listings SET pickup_date = CURRENT_DATE - 1 WHERE id = $1", [offers.SURPRISE_BAG.id]);
    const before = await points();
    assert.equal((await setStatus(id, 'COMPLETED')).status, 200);
    assert.equal(await points(), before + 10);
  });
});
