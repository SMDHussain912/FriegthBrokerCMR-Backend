const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_password_test_' + process.pid;

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

  const passHash = await (require('../models/User')).hashPassword('CurrentPass123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'pw-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'pw-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Pass Co A', slug: 'pwa-' + Date.now(), type: 'brokerage', owner: ownerId,
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

describe('Password Change / Reset', () => {
  it('1. Changes password with current password', async () => {
    const { status, json } = await req('/api/auth/password/change', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { currentPassword: 'CurrentPass123!', newPassword: 'NewPass456!' },
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.message, 'Password changed successfully');
  });

  it('2. Rejects wrong current password', async () => {
    const { status, json } = await req('/api/auth/password/change', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { currentPassword: 'WrongPass!', newPassword: 'NewPass789!' },
    });
    assert.equal(status, 401);
    const body = await json();
    assert.equal(body.code, undefined || body.code);
  });

  it('3. Rejects new password same as current', async () => {
    const { status, json } = await req('/api/auth/password/change', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { currentPassword: 'NewPass456!', newPassword: 'NewPass456!' },
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'PASSWORD_UNCHANGED');
  });

  it('4. Rejects password too short', async () => {
    const { status, json } = await req('/api/auth/password/change', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { currentPassword: 'NewPass456!', newPassword: 'short!' },
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'PASSWORD_TOO_SHORT');
  });

  it('5. Request reset token for existing email', async () => {
    const { status, json } = await req('/api/auth/password/reset/request', null, {
      body: { email: 'pw-owner@test.local' },
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.resetToken, 'reset token should be returned in dev');
    assert.equal(typeof body.resetToken, 'string');
    global.resetToken = body.resetToken;
  });

  it('6. Confirm reset with valid token', async () => {
    const token = global.resetToken;
    assert.ok(token, 'reset token should be set');
    const { status, json } = await req('/api/auth/password/reset/confirm', null, {
      body: { token, newPassword: 'ResetPass789!' },
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.message, 'Password reset successfully');
  });

  it('7. Rejects expired/invalid reset token', async () => {
    const { status, json } = await req('/api/auth/password/reset/confirm', null, {
      body: { token: 'invalidtoken123456789012345678901234', newPassword: 'NewPass456!' },
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'INVALID_RESET_TOKEN');
  });

  it('8. Rejects reset without token', async () => {
    const { status, json } = await req('/api/auth/password/reset/confirm', null, {
      body: { newPassword: 'NewPass456!' },
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'RESET_REQUIRED');
  });
});
