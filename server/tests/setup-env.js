// Preloaded with `node --import` so it runs before any application module reads the environment.
import { assertNonProductionReset, assertTestDatabase } from '../src/db/safety.js';

assertNonProductionReset();
assertTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
process.env.NODE_ENV = 'test';
// Tests always exercise mock integrations, never real external APIs.
process.env.OPENAI_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
