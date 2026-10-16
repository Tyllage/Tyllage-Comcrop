import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids } from './helpers.js';
import { addDays, todayISO } from '../src/utils/dates.js';

describe('Buyer demand', () => {
  let I;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
  });
  after(clearTokens);

  it('business buyer registers demand against a farm produce item', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const res = await api().post('/api/demand').set('Authorization', restaurant).send({
      produceId: await I.produce('Sweet Basil'), quantity: 15, requiredDate: addDays(todayISO(), 4), maxPrice: 27, recurrence: 'WEEKLY',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.produceName, 'Sweet Basil');
    assert.equal(res.body.data.farmId, I.comcrop);
    assert.equal(res.body.data.status, 'OPEN');
    assert.equal(res.body.data.buyerName, 'Restaurant A');
  });

  it('consumer registers open-market interest by produce name', async () => {
    const consumer = await login(ACCOUNTS.consumer);
    const res = await api().post('/api/demand').set('Authorization', consumer).send({
      produceName: 'Lettuce', quantity: 1, requiredDate: addDays(todayISO(), 7),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.farmId, null);
  });

  it('validates quantity and required date', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const zero = await api().post('/api/demand').set('Authorization', restaurant).send({ produceName: 'Kale', quantity: 0, requiredDate: addDays(todayISO(), 2) });
    assert.equal(zero.status, 400);
    const past = await api().post('/api/demand').set('Authorization', restaurant).send({ produceName: 'Kale', quantity: 5, requiredDate: addDays(todayISO(), -1) });
    assert.equal(past.status, 400);
    const noProduce = await api().post('/api/demand').set('Authorization', restaurant).send({ quantity: 5, requiredDate: addDays(todayISO(), 2) });
    assert.equal(noProduce.status, 400);
  });

  it('farm demand view includes directed and open-market demand; buyers only see their own', async () => {
    const admin = await login(ACCOUNTS.farmAdmin);
    const farm = await api().get(`/api/demand?farmId=${I.comcrop}`).set('Authorization', admin);
    assert.equal(farm.status, 200);
    assert.ok(farm.body.data.some((d) => d.farmId === null));
    assert.ok(farm.body.data.some((d) => d.farmId === I.comcrop));

    const hotel = await login(ACCOUNTS.hotel);
    const mine = await api().get('/api/demand').set('Authorization', hotel);
    assert.ok(mine.body.data.length > 0);
    assert.ok(mine.body.data.every((d) => d.buyerName === 'Hotel B'));
  });

  it('farm admin records demand on behalf of a managed buyer', async () => {
    const admin = await login(ACCOUNTS.farmAdmin);
    const res = await api().post('/api/demand').set('Authorization', admin).send({
      farmId: I.comcrop, buyerId: await I.buyer('Café D'), produceId: await I.produce('Mint'), quantity: 2, requiredDate: addDays(todayISO(), 5),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.buyerName, 'Café D');
  });

  it('buyer can cancel their demand, but not someone else’s', async () => {
    const hotel = await login(ACCOUNTS.hotel);
    const restaurant = await login(ACCOUNTS.restaurant);
    const mine = (await api().get('/api/demand').set('Authorization', hotel)).body.data.find((d) => d.status === 'OPEN');
    assert.equal((await api().post(`/api/demand/${mine.id}/cancel`).set('Authorization', restaurant)).status, 403);
    const res = await api().post(`/api/demand/${mine.id}/cancel`).set('Authorization', hotel);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CANCELLED');
  });
});
