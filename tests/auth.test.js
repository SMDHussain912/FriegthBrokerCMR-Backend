const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const User = require('../models/User');
const { dropTestDatabase } = require('./helpers/testDb');

/**
 * Authentication regression tests.
 *
 * These cover the exact endpoints the mobile client calls:
 *   POST /api/auth/register  -> returns { token, user }
 *   POST /api/auth/login     -> returns { token, user }
 *   GET  /api/auth/me        -> returns { user } (session restore)
 *
 * The register test guards a real production bug: the handler used
 * `User.statics.hashPassword(...)`, but Mongoose does not expose `statics`
 * on the model, so every registration threw a 500 and no account could
 * ever be created.
 */

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_auth_test_' + process.pid;

let server;
let baseUrl;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assert.ok(
    (mongoose.connection.name || '').includes('test'),
    'Refusing cleanup: not a test database (got ' + mongoose.connection.name + ')'
  );
  await User.deleteMany({});

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

describe('Authentication API', () => {
  it('POST /api/auth/register creates an account and returns a token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Mobile Tester',
        email: 'mobile.tester@example.com',
        password: 'MobileTest123!',
        role: 'broker',
      }),
    });

    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.token, 'register must return a JWT');
    assert.equal(body.user.email, 'mobile.tester@example.com');
    assert.equal(body.user.role, 'broker');
    assert.equal(body.user.passwordHash, undefined, 'passwordHash must never be returned');

    // The account must actually be persisted.
    const stored = await User.findOne({ email: 'mobile.tester@example.com' });
    assert.ok(stored, 'user must be persisted');
  });

  it('POST /api/auth/register rejects a short password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Short Pass',
        email: 'short.pass@example.com',
        password: 'short',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'PASSWORD_TOO_SHORT');
  });

  it('POST /api/auth/register rejects a duplicate email', async () => {
    const payload = {
      name: 'Duplicate',
      email: 'mobile.tester@example.com',
      password: 'MobileTest123!',
    };

    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'EMAIL_EXISTS');
  });

  it('POST /api/auth/register ignores a forged admin role (always broker)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Forged Admin',
        email: 'forged.admin@example.com',
        password: 'ForgedAdmin123!',
        role: 'admin',
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    // The server always assigns broker; a client can never self-escalate.
    assert.equal(body.user.role, 'broker');

    const stored = await User.findOne({ email: 'forged.admin@example.com' });
    assert.ok(stored);
    assert.equal(stored.role, 'broker');
  });

  it('POST /api/auth/register ignores a forged compliance_officer role (always broker)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Forged Compliance',
        email: 'forged.compliance@example.com',
        password: 'ForgedCompliance123!',
        role: 'compliance_officer',
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.role, 'broker');

    const stored = await User.findOne({ email: 'forged.compliance@example.com' });
    assert.ok(stored);
    assert.equal(stored.role, 'broker');
  });

  it('POST /api/auth/login returns a token for valid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'mobile.tester@example.com',
        password: 'MobileTest123!',
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.token);
    assert.equal(body.user.email, 'mobile.tester@example.com');
  });

  it('POST /api/auth/login rejects a wrong password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'mobile.tester@example.com',
        password: 'WrongPassword123!',
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  it('GET /api/auth/me restores the session from a bearer token', async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'mobile.tester@example.com',
        password: 'MobileTest123!',
      }),
    });
    const { token } = await login.json();

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.email, 'mobile.tester@example.com');
    assert.equal(body.user.role, 'broker');
  });

  it('GET /api/auth/me rejects a missing token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
  });
});
