import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The verify token must be set before the app (and its env module) loads.
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
const { api } = await import('./helpers.js');

describe('WhatsApp webhook verification', () => {
  const verify = (query) => api().get('/api/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', ...query });

  it('echoes a valid challenge as plain text', async () => {
    const res = await verify({ 'hub.challenge': '1158201444' });
    assert.equal(res.status, 200);
    assert.equal(res.text, '1158201444');
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('rejects a wrong verify token', async () => {
    assert.equal((await verify({ 'hub.verify_token': 'nope', 'hub.challenge': '123' })).status, 403);
  });

  it('never reflects markup or malformed challenges', async () => {
    for (const challenge of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '', 'x'.repeat(129)]) {
      const res = await verify({ 'hub.challenge': challenge });
      assert.equal(res.status, 403);
      assert.doesNotMatch(res.text, /script|onerror/);
    }
    // Repeated parameters arrive as an array and are rejected too.
    const res = await api().get('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1&hub.challenge=2');
    assert.equal(res.status, 403);
  });
});
