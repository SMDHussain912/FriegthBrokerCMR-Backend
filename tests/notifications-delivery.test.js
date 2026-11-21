const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_notify_delivery_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let companyA;
let userId;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('NotifyOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'notify-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'notify-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Notify Co A', slug: 'nota-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  userId = (await insert('users', {
    name: 'Recipient', email: 'recipient@test.local', passwordHash: passHash, role: 'broker',
  })).insertedId;

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

describe('Notification Delivery (CRM)', () => {
  it('1. Sends an email notification via email adapter', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        user: String(userId),
        type: 'info',
        title: 'Welcome',
        message: 'Welcome to FreightBrokerCMR',
        channels: ['email'],
        email: 'user@example.com'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.notification._id);
    assert.ok(Array.isArray(body.deliveries));
    assert.equal(body.deliveries.length, 1);
    assert.equal(body.deliveries[0].channel, 'email');
  });

  it('2. Sends an SMS notification via SMS adapter', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        user: String(userId),
        type: 'exception',
        title: 'Load Delayed',
        message: 'Load LD-002 is delayed',
        channels: ['sms'],
        phone: '+15551234567'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    const smsDelivery = body.deliveries.find((d) => d.channel === 'sms');
    assert.ok(smsDelivery, 'SMS delivery record exists');
  });

  it('3. Sends a push notification via push adapter', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        user: String(userId),
        type: 'tender',
        title: 'New Tender',
        message: 'New tender available',
        channels: ['push'],
        deviceToken: 'device-token-123'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    const pushDelivery = body.deliveries.find((d) => d.channel === 'push');
    assert.ok(pushDelivery, 'Push delivery record exists');
  });

  it('4. Lists delivery history', async () => {
    const { status, json } = await getReq('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.deliveries));
    assert.ok(body.deliveries.length >= 3);
  });

  it('5. Gets a single delivery record', async () => {
    const { status, json } = await getReq('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const deliveryId = json.deliveries[0]._id;
    const g = await getReq(`/api/notifications/delivery/${deliveryId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.delivery._id, deliveryId);
  });

  it('6. Rejects without company context', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      body: { user: String(userId), type: 'info', title: 'X', message: 'Y' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('7. Rejects demo mode', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { user: String(userId), type: 'info', title: 'X', message: 'Y' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('8. Rejects invalid channel', async () => {
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { user: String(userId), type: 'info', title: 'X', message: 'Y', channels: ['fax'] }
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'INVALID_CHANNEL');
  });

  it('9. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Notify Co B', slug: 'notb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/notifications/delivery', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { user: String(userId), type: 'info', title: 'X', message: 'Y' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
