const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_notify_pref_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let companyA;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('PrefOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'pref-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'pref-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Preference Co A', slug: 'prefa-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
});

after(async () => {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch {}
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  assertTestDatabase();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

const req = async (path, token, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(headers.body || {}),
  });
  return { res, status: res.status, json: async () => await res.json() };
};

const getReq = async (path, token, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
  });
  return { res, status: res.status, json: async () => await res.json() };
};

describe('Notification Preferences', () => {
  it('1. Gets default preferences when none exist', async () => {
    const { status, json } = await getReq('/api/notifications/preferences', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.preferences);
    assert.equal(body.preferences.user, String(ownerId));
    assert.equal(body.preferences.email, true);
    assert.equal(body.preferences.sms, false);
    assert.equal(body.preferences.push, true);
    assert.ok(body.preferences.types);
    assert.equal(body.preferences.types.email, true);
    assert.ok(body.preferences.quietHours);
  });

  it('2. Updates preferences', async () => {
    const { status, json } = await req('/api/notifications/preferences', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        email: false,
        sms: true,
        push: false,
        types: { email: false, sms: true, push: false, assignment: true, tender: true },
        quietHours: { enabled: true, start: '22:00', end: '08:00', timezone: 'America/New_York' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.preferences.email, false);
    assert.equal(body.preferences.sms, true);
    assert.equal(body.preferences.push, false);
    assert.equal(body.preferences.types.email, false);
    assert.equal(body.preferences.types.sms, true);
    assert.equal(body.preferences.types.push, false);
    assert.ok(body.preferences.quietHours.enabled);
    assert.equal(body.preferences.quietHours.timezone, 'America/New_York');
  });

  it('3. Gets updated preferences', async () => {
    const { status, json } = await getReq('/api/notifications/preferences', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.preferences.email, false);
    assert.equal(body.preferences.sms, true);
    assert.equal(body.preferences.push, false);
    assert.equal(body.preferences.quietHours.enabled, true);
  });

  it('4. Cleans up old notifications', async () => {
    const { status, json } = await req('/api/notifications/cleanup', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { olderThanDays: 30 }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(typeof body.deletedCount === 'number');
    assert.equal(body.olderThanDays, 30);
  });

  it('5. Rejects without company context', async () => {
    const { status, json } = await getReq('/api/notifications/preferences', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('6. Rejects demo mode', async () => {
    const { status, json } = await req('/api/notifications/preferences', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { email: false }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('7. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Pref Co B', slug: 'prefb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/notifications/preferences', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { email: false }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
