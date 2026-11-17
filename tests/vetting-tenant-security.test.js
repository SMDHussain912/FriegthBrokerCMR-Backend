const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const VettingConfiguration = require('../models/VettingConfiguration');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_vetting_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;

let userMulti, tokenMulti;
let userB, tokenB;
let companyA, companyB;
let carrierA, carrierB, demoCarrier;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([
    Carrier.syncIndexes(),
    Company.syncIndexes(),
    Membership.syncIndexes(),
    User.syncIndexes(),
    VettingConfiguration.syncIndexes()
  ]);

  const passHash = await User.hashPassword('Password123!');

  userMulti = await User.create({
    name: 'Multi Member',
    email: 'multi@example.com',
    passwordHash: passHash,
    role: 'compliance_officer'
  });
  tokenMulti = signToken(userMulti);

  userB = await User.create({
    name: 'Company B Broker',
    email: 'userb@example.com',
    passwordHash: passHash,
    role: 'broker'
  });
  tokenB = signToken(userB);

  companyA = await Company.create({ name: 'Vetting Alpha', slug: 'vetting-alpha-' + Date.now(), type: 'brokerage', owner: userMulti._id });
  companyB = await Company.create({ name: 'Vetting Beta', slug: 'vetting-beta-' + Date.now(), type: 'brokerage', owner: userB._id });

  await Membership.create({ user: userMulti._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: userMulti._id, company: companyB._id, role: 'compliance_officer', isActive: true });
  await Membership.create({ user: userB._id, company: companyB._id, role: 'broker', isActive: true });

  carrierA = await Carrier.create({
    company: companyA._id,
    dotNumber: 'VA111111',
    mcNumber: 'MCVA111111',
    legalName: 'Alpha Vet Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false
  });

  carrierB = await Carrier.create({
    company: companyB._id,
    dotNumber: 'VB222222',
    mcNumber: 'MCVB222222',
    legalName: 'Beta Vet Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false
  });

  demoCarrier = await Carrier.create({
    dotNumber: 'VD999999',
    mcNumber: 'MCVD999999',
    legalName: 'Demo Vet Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: true
  });

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

describe('Vetting Tenant Isolation and Security', () => {
  it('1. Multiple memberships require exact active-company selection', async () => {
    const missing = await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}` }
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).code, 'COMPANY_CONTEXT_REQUIRED');

    const resA = await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.success, true);

    const resB = await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyB._id) }
    });
    assert.equal(resB.status, 200);
    assert.equal((await resB.json()).success, true);
  });

  it('2. Cross-company vetting configuration access is denied', async () => {
    const res = await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenB}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'NOT_A_MEMBER');
  });

  it('3. Unauthorized configuration updates are denied by role', async () => {
    // userB is broker in companyB (read allowed, write denied)
    const res = await fetch(`${baseUrl}/api/vetting/configuration`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
        'X-Company-Id': String(companyB._id)
      },
      body: JSON.stringify({ minimumAuthorityDays: 120 })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN_ROLE');
  });

  it('4. Authorized configuration update is scoped to exact active company', async () => {
    const updateA = await fetch(`${baseUrl}/api/vetting/configuration`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMulti}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ minimumAuthorityDays: 45, minimumLiabilityLimit: 1500000, reason: 'Alpha policy' })
    });
    assert.equal(updateA.status, 200);
    const cfgA = (await updateA.json()).configuration;
    assert.equal(String(cfgA.company), String(companyA._id));
    assert.equal(cfgA.minimumAuthorityDays, 45);
    assert.equal(cfgA.minimumLiabilityLimit, 1500000);

    const updateB = await fetch(`${baseUrl}/api/vetting/configuration`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMulti}`,
        'X-Company-Id': String(companyB._id)
      },
      body: JSON.stringify({ minimumAuthorityDays: 60, minimumLiabilityLimit: 2000000, reason: 'Beta policy' })
    });
    assert.equal(updateB.status, 200);
    const cfgB = (await updateB.json()).configuration;
    assert.equal(String(cfgB.company), String(companyB._id));
    assert.equal(cfgB.minimumAuthorityDays, 60);
    assert.equal(cfgB.minimumLiabilityLimit, 2000000);

    const readA = await (await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyA._id) }
    })).json();
    const readB = await (await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyB._id) }
    })).json();
    assert.equal(readA.configuration.minimumAuthorityDays, 45);
    assert.equal(readA.configuration.minimumLiabilityLimit, 1500000);
    assert.equal(readB.configuration.minimumAuthorityDays, 60);
    assert.equal(readB.configuration.minimumLiabilityLimit, 2000000);
  });

  it('5. Cross-company carrier evaluation access is denied', async () => {
    // userB (companyB member) tries to evaluate carrierA owned by companyA while in companyB context
    const res = await fetch(`${baseUrl}/api/carriers/${carrierA._id}/vet`, {
      headers: { Authorization: `Bearer ${tokenB}`, 'X-Company-Id': String(companyB._id) }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('6. Role-based evaluation permissions are enforced', async () => {
    // Create a viewer membership in companyA and ensure evaluation denied
    const passHash = await User.hashPassword('Password123!');
    const viewer = await User.create({ name: 'Viewer', email: 'viewer@example.com', passwordHash: passHash, role: 'broker' });
    await Membership.create({ user: viewer._id, company: companyA._id, role: 'viewer', isActive: true });
    const viewerToken = signToken(viewer);

    const res = await fetch(`${baseUrl}/api/carriers/${carrierA._id}/vet`, {
      headers: { Authorization: `Bearer ${viewerToken}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'FORBIDDEN_ROLE');

    // broker_owner (userMulti in companyA) can evaluate
    const ok = await fetch(`${baseUrl}/api/carriers/${carrierA._id}/vet`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.success, true);
    assert.ok(body.evaluation);
    assert.equal(String(body.evaluation.carrierId), String(carrierA._id));
  });

  it('7. Demo/production separation is enforced for vetting evaluation and config', async () => {
    const demoEval = await fetch(`${baseUrl}/api/carriers/${demoCarrier._id}/vet`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(demoEval.status, 403);

    const prodEvalInDemo = await fetch(`${baseUrl}/api/carriers/${carrierA._id}/vet`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(prodEvalInDemo.status, 403);

    const demoConfig = await fetch(`${baseUrl}/api/vetting/configuration`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(demoConfig.status, 403);
  });

  it('8. Vetting audit history is isolated per company', async () => {
    // Trigger evaluation in companyA to ensure audit entries exist
    const evalA = await fetch(`${baseUrl}/api/carriers/${carrierA._id}/vet`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(evalA.status, 200);

    const auditARes = await fetch(`${baseUrl}/api/vetting/configuration/audit`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(auditARes.status, 200);
    const auditA = (await auditARes.json()).auditLog;
    assert.ok(Array.isArray(auditA));
    assert.ok(auditA.length >= 1);
    // ensure no audit metadata references companyB carrier
    for (const entry of auditA) {
      if (entry.metadata && entry.metadata.carrierId) {
        assert.notEqual(String(entry.metadata.carrierId), String(carrierB._id));
      }
    }

    const auditBRes = await fetch(`${baseUrl}/api/vetting/configuration/audit`, {
      headers: { Authorization: `Bearer ${tokenMulti}`, 'X-Company-Id': String(companyB._id) }
    });
    assert.equal(auditBRes.status, 200);
    const auditB = (await auditBRes.json()).auditLog;
    assert.ok(Array.isArray(auditB));
    for (const entry of auditB) {
      if (entry.metadata && entry.metadata.carrierId) {
        assert.notEqual(String(entry.metadata.carrierId), String(carrierA._id));
      }
    }

    // Cross-company audit read denied
    const cross = await fetch(`${baseUrl}/api/vetting/configuration/audit`, {
      headers: { Authorization: `Bearer ${tokenB}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(cross.status, 403);
  });
});
