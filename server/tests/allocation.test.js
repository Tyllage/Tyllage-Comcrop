import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch, batchStock, pool } from './helpers.js';

describe('Allocations and orders', () => {
  let I;
  let admin;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
  });
  after(clearTokens);

  it('approving a match creates order, order item and allocation, and updates stock', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    const m = byBuyer['Restaurant A'];
    const res = await api().post(`/api/matches/${m.id}/approve`).set('Authorization', admin).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.match.status, 'APPROVED');
    assert.equal(res.body.data.batch.confirmedDemand, 24 + 15);
    assert.equal(res.body.data.batch.unallocatedQuantity, 46 - 15);

    const order = await api().get(`/api/orders/${res.body.data.orderId}`).set('Authorization', admin);
    assert.equal(order.body.data.status, 'CONFIRMED');
    assert.equal(order.body.data.items[0].quantity, 15);
    const demand = await pool.query('SELECT status, fulfilled_quantity FROM demand_requests WHERE id = $1', [m.demandRequestId]);
    assert.equal(demand.rows[0].status, 'FULFILLED');
    // The buyer was notified in-app.
    const restaurant = await login(ACCOUNTS.restaurant);
    const notes = await api().get('/api/notifications').set('Authorization', restaurant);
    assert.ok(notes.body.data.some((n) => n.notificationType === 'ORDER_CONFIRMED'));
  });

  it('cannot approve the same match twice', async () => {
    const { matches } = await api().get(`/api/harvests/${I.kale}/matches`).set('Authorization', admin).then((r) => r.body.data);
    const approved = matches.find((m) => m.status === 'APPROVED');
    const res = await api().post(`/api/matches/${approved.id}/approve`).set('Authorization', admin).send({});
    assert.equal(res.status, 409);
  });

  it('rejects over-allocation with an edited quantity', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    const m = byBuyer['Hotel B'];
    // Unallocated is 31kg; ask for more than remains on the batch.
    await pool.query('UPDATE demand_requests SET quantity = 100 WHERE id = $1', [m.demandRequestId]);
    const res = await api().post(`/api/matches/${m.id}/approve`).set('Authorization', admin).send({ quantity: 40 });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OVER_ALLOCATION');
    const stock = await batchStock(I.kale);
    assert.equal(stock.remaining_quantity, 31);
    await pool.query('UPDATE demand_requests SET quantity = 18 WHERE id = $1', [m.demandRequestId]);
  });

  it('rejects an edited quantity larger than the buyer needs', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    const m = byBuyer['Community Buyer C'];
    const res = await api().post(`/api/matches/${m.id}/approve`).set('Authorization', admin).send({ quantity: 9 });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DEMAND_EXCEEDED');
  });

  it('concurrent approvals can never exceed available stock', async () => {
    const { byBuyer } = await runMatch(I.kale, admin); // 31kg unallocated
    const hotel = byBuyer['Hotel B'];
    const community = byBuyer['Community Buyer C'];
    await pool.query('UPDATE demand_requests SET quantity = 25 WHERE id = ANY($1::int[])', [[hotel.demandRequestId, community.demandRequestId]]);
    const results = await Promise.all([
      api().post(`/api/matches/${hotel.id}/approve`).set('Authorization', admin).send({ quantity: 20 }),
      api().post(`/api/matches/${community.id}/approve`).set('Authorization', admin).send({ quantity: 20 }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const stock = await batchStock(I.kale);
    assert.equal(stock.remaining_quantity, 11);
    assert.ok(stock.allocated_quantity <= stock.harvest_quantity);
  });

  it('cancelling an order restores availability and reopens the demand', async () => {
    const before = await batchStock(I.kale);
    const orders = (await api().get(`/api/orders?farmId=${I.comcrop}&status=CONFIRMED`).set('Authorization', admin)).body.data;
    const order = orders.find((o) => o.source === 'HARVESTMATCH' && o.items[0].harvestBatchId === I.kale);
    const qty = order.items[0].quantity;

    const noReason = await api().patch(`/api/orders/${order.id}/status`).set('Authorization', admin).send({ status: 'CANCELLED' });
    assert.equal(noReason.status, 400);
    const res = await api().patch(`/api/orders/${order.id}/status`).set('Authorization', admin).send({ status: 'CANCELLED', reason: 'Test cancellation' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CANCELLED');

    const afterStock = await batchStock(I.kale);
    assert.equal(afterStock.remaining_quantity, before.remaining_quantity + qty);
    const demand = await pool.query('SELECT status, fulfilled_quantity FROM demand_requests WHERE id = $1', [order.items[0].demandRequestId]);
    assert.notEqual(demand.rows[0].status, 'FULFILLED');
    // A cancelled order cannot be revived.
    const revive = await api().patch(`/api/orders/${order.id}/status`).set('Authorization', admin).send({ status: 'CONFIRMED' });
    assert.equal(revive.status, 409);
  });

  it('farm staff progress fulfilment but cannot cancel', async () => {
    const staff = await login(ACCOUNTS.farmStaff);
    const order = (await api().get(`/api/orders?farmId=${I.comcrop}&status=CONFIRMED`).set('Authorization', staff)).body.data[0];
    assert.equal((await api().patch(`/api/orders/${order.id}/status`).set('Authorization', staff).send({ status: 'CANCELLED', reason: 'x' })).status, 403);
    assert.equal((await api().patch(`/api/orders/${order.id}/status`).set('Authorization', staff).send({ status: 'READY' })).body.data.status, 'READY');
    assert.equal((await api().patch(`/api/orders/${order.id}/status`).set('Authorization', staff).send({ status: 'COMPLETED' })).body.data.status, 'COMPLETED');
  });
});
