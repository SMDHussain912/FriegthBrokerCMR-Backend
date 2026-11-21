const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_notification_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let userBId;
let userBToken;
let companyA;
let notificationId;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('NotOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'not-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'not-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Notification Co A', slug: 'nota-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  userBId = (await insert('users', {
    name: 'User B', email: 'user-b@test.local', passwordHash: passHash, role: 'broker',
  })).insertedId;
  userBToken = signToken({ _id: userBId, email: 'user-b@test.local', role: 'broker' });

  notificationId = (await insert('notifications', {
    user: ownerId, company: companyA, type: 'assignment', title: 'New Assignment', message: 'Load LD-001 assigned',
    isRead: false, isDemoData: false,
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

describe('Notifications', () => {
  it('1. Creates a notification', async () => {
    const { status, json } = await req('/api/notifications', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        user: String(ownerId),
        type: 'exception',
        title: 'Load Delayed',
        message: 'Load LD-002 is delayed due to weather'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.notification.notificationId || body.notification._id, 'notification id generated');
    assert.equal(body.notification.user, String(ownerId));
    assert.equal(body.notification.type, 'exception');
    assert.equal(body.notification.isRead, false);
    assert.equal(body.notification.title, 'Load Delayed');
  });

  it('2. Lists notifications with unread count', async () => {
    const { status, json } = await getReq('/api/notifications', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.notifications.length >= 1);
    assert.ok(body.unreadCount >= 1);
    assert.ok(body.page);
    assert.ok(body.limit);
  });

  it('3. Gets a single notification', async () => {
    const { status, json } = await getReq('/api/notifications', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const body = await json();
    const nId = body.notifications[0]._id;
    const g = await getReq(`/api/notifications/${nId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.notification._id, nId);
  });

  it('4. Marks notification read', async () => {
    const { status, json } = await getReq('/api/notifications', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const body = await json();
    const unread = body.notifications.find((n) => !n.isRead);
    const nId = unread ? unread._id : notificationId;
    const m = await req(`/api/notifications/${nId}/read`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(m.status, 200);
    const mb = await m.json();
    assert.equal(mb.success, true);
    assert.equal(mb.notification.isRead, true);
    assert.ok(mb.notification.readAt);
  });

  it('5. Marks all notifications read', async () => {
    const { status, json } = await req('/api/notifications/read-all', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(typeof body.modifiedCount === 'number');
  });

  it('6. Deletes a notification', async () => {
    const delRes = await insert('notifications', {
      user: ownerId, company: companyA, type: 'info', title: 'To Delete', message: 'Delete me',
      isRead: false, isDemoData: false,
    });
    const d = await req(`/api/notifications/${delRes.insertedId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(d.status, 200);
    const db = await d.json();
    assert.equal(db.success, true);
  });

  it('7. Rejects without company context', async () => {
    const { status, json } = await req('/api/notifications', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('8. Rejects demo mode', async () => {
    const { status, json } = await req('/api/notifications', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { user: String(ownerId), type: 'info', title: 'Demo', message: 'Demo notification' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('9. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Notification Co B', slug: 'notb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/notifications', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { user: String(ownerId), type: 'info', title: 'Cross', message: 'Cross company' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
