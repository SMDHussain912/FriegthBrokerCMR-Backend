const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Load = require('../models/Load');
const User = require('../models/User');
const { DEMO_CARRIERS, DEMO_LOADS } = require('../services/mockData/fmcsaDemoData');
const { dropTestDatabase } = require('./helpers/testDb');

// Isolated DB + guard: cleanup refuses to run unless db name contains "test".
// The DB name carries the PID so that two test processes (e.g. a parallel
// CI matrix or a developer running the suite twice) can never share state.
const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_api_test_' + process.pid;
const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();

  // Ensure test data exists
  await Carrier.deleteMany({ isDemoData: true });
  await Load.deleteMany({ isDemoData: true });
  await User.deleteMany({ isDemoData: true });
  await Carrier.insertMany(DEMO_CARRIERS);
  await Load.insertMany(DEMO_LOADS);

  // Start server on ephemeral port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });


    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.membership.id);
    assert.equal(body.membership.userId, String(targetUser._id));
    assert.equal(body.membership.companyId, String(company._id));
    assert.equal(body.membership.role, 'broker');
    assert.ok(body.membership.name);
    assert.ok(body.membership.email);
    assert.ok(body.membership.joinedAt);
    assert.ok(body.membership.isActive);
  });

  it('ordinary member cannot add members', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regularMember.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker' })
    });
    assert.equal(res.status, 403);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Forbidden: insufficient role to add members');
  });

  it('non-member cannot add members', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nonMemberUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker' })
    });
    assert.equal(res.status, 403);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Forbidden: no active membership in this company');
  });

  it('unauthenticated request is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST'
    });
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  it('invalid company ID returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/companies/invalid-id/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker' })
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Invalid company ID format');
  });

  it('invalid user ID returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: 'invalid-id', role: 'broker' })
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Invalid user ID format');
  });

  it('nonexistent user returns 404', async () => {
    const fakeUserId = new mongoose.Types.ObjectId();
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: fakeUserId, role: 'broker' })
    });
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'User not found');
  });

  it('invalid role for company type is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members?role=carrier_owner`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'carrier_owner' })
    });
    assert.equal(res.status, 403);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Forbidden: cannot assign role carrier_owner');
  });

  it('duplicate membership is rejected', async () => {
    await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker' })
    });

    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker' })
    });
    assert.equal(res.status, 409);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'User already has a membership in this company');
  });

  it('client-supplied permissions are ignored', async () => {
    const res = await fetch(`${baseUrl}/api/companies/${company._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerUser.jwtToken}` },
      body: JSON.stringify({ userId: targetUser._id, role: 'broker', permissions: ['VIEW_LOADS'] })
    });
    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.membership.role, 'broker');
    assert.strictEqual(body.membership.permissions, undefined);
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  assertTestDatabase();
  await Carrier.deleteMany({ isDemoData: true });
  await Load.deleteMany({ isDemoData: true });
  await User.deleteMany({ isDemoData: true });
  // Drop the whole PID-scoped database so no test database is left behind.
  // The connection is closed first: Mongoose's background model init would
  // otherwise re-create the collections right after the drop.
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

describe('API Endpoint Integration Tests', () => {

  it('GET /api/health returns 200 OK with healthy status and connected database', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, 'healthy');
    assert.equal(body.database.status, 'connected');
    assert.equal(body.service, 'FreightBrokerCMR Backend API');
  });

  it('GET /api/carriers returns list of demo carriers', async () => {
    const res = await fetch(`${baseUrl}/api/carriers`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.count >= 8);
    assert.ok(Array.isArray(body.carriers));
  });

  it('GET /api/loads requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/loads`);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  it('GET /api/loads returns list of demo loads when authenticated', async () => {
    // Register + log in a broker to obtain a JWT (roles from server)
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Api Tester',
        email: 'api.tester@example.com',
        password: 'ApiTester123!',
      }),
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'api.tester@example.com',
        password: 'ApiTester123!',
      }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.ok(token, 'login must return a JWT');

    const res = await fetch(`${baseUrl}/api/loads`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.count >= 2);
  });

  it('GET /api/loads/:loadId/eligibility/:carrierId evaluates Apex Freight as PASS on Reefer Load', async () => {
    const load = await Load.findOne({ loadNumber: 'LD-1029' });
    const carrier = await Carrier.findOne({ dotNumber: '2849102' }); // Apex

    assert.ok(load, 'Load LD-1029 must exist');
    assert.ok(carrier, 'Apex carrier must exist');

    const res = await fetch(`${baseUrl}/api/loads/${load._id}/eligibility/${carrier._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.evaluation.overallStatus, 'PASS');
    assert.equal(body.evaluation.isEligible, true);
    assert.equal(body.evaluation.summary.failedChecks, 0);
  });

  it('GET /api/loads/:loadId/eligibility/:carrierId evaluates Sub-Par as FAIL ($100k deficit) on $200k Reefer Load', async () => {
    const load = await Load.findOne({ loadNumber: 'LD-1029' });
    const carrier = await Carrier.findOne({ dotNumber: '3109281' }); // Sub-Par ($100k limit)

    const res = await fetch(`${baseUrl}/api/loads/${load._id}/eligibility/${carrier._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.evaluation.overallStatus, 'FAIL');
    assert.equal(body.evaluation.isEligible, false);

    const cargoCheck = body.evaluation.checks.find(c => c.ruleKey === 'CARGO_LIMIT_MATCH');
    assert.equal(cargoCheck.status, 'FAIL');
    assert.equal(cargoCheck.reasonCode, 'INSUFFICIENT_LIMIT');
  });

  it('GET /api/loads/:loadId/eligibility/:carrierId evaluates Frozen Transit as FAIL due to missing Reefer Endorsement', async () => {
    const load = await Load.findOne({ loadNumber: 'LD-1029' });
    const carrier = await Carrier.findOne({ dotNumber: '2940192' }); // Frozen Transit (no reefer endorsement)

    const res = await fetch(`${baseUrl}/api/loads/${load._id}/eligibility/${carrier._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.evaluation.overallStatus, 'FAIL');

    const reeferCheck = body.evaluation.checks.find(c => c.ruleKey === 'REEFER_ENDORSEMENT');
    assert.equal(reeferCheck.status, 'FAIL');
    assert.equal(reeferCheck.reasonCode, 'MISSING_REEFER_ENDORSEMENT');
  });

  it('GET /api/loads/:loadId/eligibility/:carrierId evaluates Pending Express as NEEDS_REVIEW (Unverified COI)', async () => {
    const load = await Load.findOne({ loadNumber: 'LD-1029' });
    const carrier = await Carrier.findOne({ dotNumber: '3892019' }); // Pending Express (unverified doc)

    const res = await fetch(`${baseUrl}/api/loads/${load._id}/eligibility/${carrier._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.evaluation.overallStatus, 'NEEDS_REVIEW');
    assert.equal(body.evaluation.isEligible, false);

    const cargoCheck = body.evaluation.checks.find(c => c.ruleKey === 'CARGO_LIMIT_MATCH');
    assert.equal(cargoCheck.status, 'NEEDS_REVIEW');
    assert.equal(cargoCheck.reasonCode, 'UNVERIFIED_DOCUMENT');
  });

  it('GET /api/loads/:loadId/eligibility/:carrierId evaluates Revoked Haulers as FAIL (Revoked Authority)', async () => {
    const load = await Load.findOne({ loadNumber: 'LD-1029' });
    const carrier = await Carrier.findOne({ dotNumber: '3409182' }); // Revoked

    const res = await fetch(`${baseUrl}/api/loads/${load._id}/eligibility/${carrier._id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.evaluation.overallStatus, 'FAIL');

    const authCheck = body.evaluation.checks.find(c => c.ruleKey === 'OPERATING_AUTHORITY');
    assert.equal(authCheck.status, 'FAIL');
    assert.equal(authCheck.reasonCode, 'AUTHORITY_NOT_ACTIVE');
  });

});
