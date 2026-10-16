/**
 * WhatsApp Cloud API integration.
 *
 * Credentials are optional. Without WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID the service runs
 * in MOCK mode: it logs a redacted payload and reports status MOCK_SENT so the full flow can be
 * developed and demonstrated without sending real messages.
 *
 * Production note: business-initiated messages outside the 24-hour customer service window must use
 * pre-approved message templates (see sendTemplateMessage). Free-form text only works inside that window.
 */
import env from '../config/env.js';

export const isWhatsAppConfigured = () => Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);

export const whatsappMode = () => (isWhatsAppConfigured() ? 'LIVE' : 'MOCK');

/** Digits only, Singapore country code assumed for 8-digit local numbers. */
export function normalisePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 8) return `65${digits}`;
  return digits;
}

const maskPhone = (p) => (p.length > 4 ? `${'*'.repeat(p.length - 4)}${p.slice(-4)}` : '****');

async function postMessage(payload) {
  if (!isWhatsAppConfigured()) {
    if (!env.isTest) {
      console.log('[whatsapp:mock]', JSON.stringify({ ...payload, to: maskPhone(payload.to) }));
    }
    return { status: 'MOCK_SENT', mode: 'MOCK', providerMessageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'FAILED', mode: 'LIVE', error: data?.error?.message || `HTTP ${res.status}` };
    return { status: 'SENT', mode: 'LIVE', providerMessageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    return { status: 'FAILED', mode: 'LIVE', error: err.message };
  }
}

export function sendTextMessage({ to, body }) {
  const phone = normalisePhone(to);
  if (!phone) return Promise.resolve({ status: 'FAILED', mode: whatsappMode(), error: 'No phone number' });
  return postMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: false, body: String(body).slice(0, 4096) },
  });
}

/** Template message (required for business-initiated messages in production). */
export function sendTemplateMessage({ to, templateName, languageCode = 'en', components = [] }) {
  const phone = normalisePhone(to);
  if (!phone) return Promise.resolve({ status: 'FAILED', mode: whatsappMode(), error: 'No phone number' });
  return postMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

/**
 * Meta webhook verification handshake (GET). Returns the challenge or null.
 * Meta's challenge is a short numeric/alphanumeric token; anything else is rejected so the echo cannot carry markup.
 */
export function verifyWebhook({ mode, token, challenge }) {
  if (mode !== 'subscribe' || !env.WHATSAPP_VERIFY_TOKEN || token !== env.WHATSAPP_VERIFY_TOKEN) return null;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return null;
  return challenge;
}
