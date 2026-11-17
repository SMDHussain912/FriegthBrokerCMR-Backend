const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_company_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let owner;
let ownerToken;
let member;
let memberToken;
let outsider;
let outsiderToken;
let targetUser;
let companyA;
let companyB;
let outsiderCompany;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([
    Company.syncIndexes(),
    Membership.syncIndexes(),
    User.syncIndexes()
  ]);

  const passHash = await User.hashPassword('Password123!');
  owner = await User.create({ name: 'Owner', email: 'owner@example.com', passwordHash: passHash, role: 'broker' });
  member = await User.create({ name: 'Member', email: 'member@example.com', passwordHash: passHash, role: 'broker' });
  outsider = await User.create({ name: 'Outsider', email: 'outsider@example.com', passwordHash: passHash, role: 'broker' });
  targetUser = await User.create({ name: 'Target', email: 'target@example.com', passwordHash: passHash, role: 'broker' });
  ownerToken = signToken(owner);
  memberToken = signToken(member);
  outsiderToken = signToken(outsider);

  companyA = await Company.create({ name: 'Company A', slug: 'company-a-' + Date.now(), type: 'brokerage', owner: owner._id, createdBy: owner._id });
  companyB = await Company.create({ name: 'Company B', slug: 'company-b-' + Date.now(), type: 'brokerage', owner: member._id, createdBy: member._id });
  outsiderCompany = await Company.create({ name: 'Outsider Co', slug: 'outsider-co-' + Date.now(), type: 'brokerage', owner: outsider._id, createdBy: outsider._id });

  await Membership.create({ user: owner._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: member._id, company: companyA._id, role: 'broker', isActive: true });
  await Membership.create({ user: owner._id, company: companyB._id, role: 'broker_admin', isActive: true });
  await Membership.create({ user: member._id, company: companyB._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: outsider._id, company: outsiderCompany._id, role: 'broker_owner', isActive: true });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assertTestDatabase();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

describe('Company Routes Security', () => {
  it('lists only companies for the authenticated user (req.user.id consistency)', async () => {
    const res = await fetch(`${baseUrl}/api/companies`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const ids = body.companies.map((c) => String(c.id));
    assert.ok(ids.includes(String(companyA._id)));
    assert.ok(ids.includes(String(companyB._id)));
    assert.ok(!ids.includes(String(outsiderCompany._id)));
  });

  it('denies company details to non-members', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${companyA._id}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'NOT_A_MEMBER');
  });

  it('requires exact active-company context and membership for member management', async () => {
    const missingContext = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(missingContext.status, 403);
    assert.equal((await missingContext.json()).code, 'COMPANY_CONTEXT_REQUIRED');

    const mismatch = await fetch(`${baseUrl}/api/companies/${companyB._id}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(mismatch.status, 403);
    assert.equal((await mismatch.json()).code, 'COMPANY_CONTEXT_MISMATCH');

    const notMember = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      headers: { Authorization: `Bearer ${outsiderToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(notMember.status, 403);
    assert.equal((await notMember.json()).code, 'NOT_A_MEMBER');
  });

  it('enforces ownership/manager permissions for adding, listing, updating, and removing members', async () => {
    const forbiddenList = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      headers: { Authorization: `Bearer ${memberToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(forbiddenList.status, 403);
    assert.equal((await forbiddenList.json()).code, 'FORBIDDEN_COMPANY_ROLE');

    const forbiddenAdd = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ userId: String(targetUser._id), role: 'broker' })
    });
    assert.equal(forbiddenAdd.status, 403);
    assert.equal((await forbiddenAdd.json()).code, 'FORBIDDEN_COMPANY_ROLE');

    const add = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ userId: String(targetUser._id), role: 'broker' })
    });
    assert.equal(add.status, 201);
    const added = await add.json();
    assert.equal(added.success, true);
    assert.equal(String(added.membership.userId), String(targetUser._id));
    assert.equal(added.membership.role, 'broker');

    const list = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(list.status, 200);
    const members = (await list.json()).members;
    const createdMembership = members.find((m) => String(m.userId) === String(targetUser._id));
    assert.ok(createdMembership);

    const invalidRole = await fetch(`${baseUrl}/api/companies/${companyA._id}/members/${createdMembership.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ role: 'carrier_owner' })
    });
    assert.equal(invalidRole.status, 400);
    assert.equal((await invalidRole.json()).code, 'INVALID_ROLE');

    const update = await fetch(`${baseUrl}/api/companies/${companyA._id}/members/${createdMembership.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ role: 'operations_manager' })
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).membership.role, 'operations_manager');

    const remove = await fetch(`${baseUrl}/api/companies/${companyA._id}/members/${createdMembership.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(remove.status, 200);
    assert.equal((await remove.json()).success, true);

    const stored = await Membership.findById(createdMembership.id);
    assert.ok(stored);
    assert.equal(stored.isActive, false);
  });

  it('enforces exact active-company context and permissions for company updates', async () => {
    const outsiderUpdate = await fetch(`${baseUrl}/api/companies/${companyA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${outsiderToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ name: 'Hacked Name' })
    });
    assert.equal(outsiderUpdate.status, 403);
    assert.equal((await outsiderUpdate.json()).code, 'NOT_A_MEMBER');

    const forbiddenRole = await fetch(`${baseUrl}/api/companies/${companyA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ name: 'Member Rename' })
    });
    assert.equal(forbiddenRole.status, 403);
    assert.equal((await forbiddenRole.json()).code, 'FORBIDDEN_COMPANY_ROLE');

    const allowed = await fetch(`${baseUrl}/api/companies/${companyA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ name: 'Company A Renamed' })
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).company.name, 'Company A Renamed');
  });

  it('rejects unauthenticated and demo-mode company management operations', async () => {
    const unauth = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: String(targetUser._id), role: 'broker' })
    });
    assert.equal(unauth.status, 401);

    const demo = await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Demo-Mode': 'true'
      },
      body: JSON.stringify({ userId: String(targetUser._id), role: 'broker' })
    });
    assert.equal(demo.status, 403);
  });
});
