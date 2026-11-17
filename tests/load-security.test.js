const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Load = require('../models/Load');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_load_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let tokenBrokerA;
let tokenViewerA;
let tokenUserB;
let companyA;
let companyB;
let carrierA;
let carrierB;
let demoCarrier;
let demoLoad;
let productionLoad;

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
    Load.syncIndexes()
  ]);

  const passHash = await User.hashPassword('Password123!');
  const brokerA = await User.create({ name: 'Broker A', email: 'brokera@example.com', passwordHash: passHash, role: 'broker' });
  const viewerA = await User.create({ name: 'Viewer A', email: 'viewera@example.com', passwordHash: passHash, role: 'broker' });
  const userB = await User.create({ name: 'User B', email: 'userb@example.com', passwordHash: passHash, role: 'broker' });
  tokenBrokerA = signToken(brokerA);
  tokenViewerA = signToken(viewerA);
  tokenUserB = signToken(userB);

  companyA = await Company.create({ name: 'Load Alpha', slug: 'load-alpha-' + Date.now(), type: 'brokerage', owner: brokerA._id });
  companyB = await Company.create({ name: 'Load Beta', slug: 'load-beta-' + Date.now(), type: 'brokerage', owner: userB._id });

  await Membership.create({ user: brokerA._id, company: companyA._id, role: 'broker', isActive: true });
  await Membership.create({ user: viewerA._id, company: companyA._id, role: 'viewer', isActive: true });
  await Membership.create({ user: userB._id, company: companyB._id, role: 'broker_owner', isActive: true });

  carrierA = await Carrier.create({
    company: companyA._id,
    dotNumber: 'LA111111',
    mcNumber: 'MCLA111111',
    legalName: 'Alpha Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false
  });
  carrierB = await Carrier.create({
    company: companyB._id,
    dotNumber: 'LB222222',
    mcNumber: 'MCLB222222',
    legalName: 'Beta Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false
  });
  demoCarrier = await Carrier.create({
    dotNumber: 'LD999999',
    mcNumber: 'MCLD999999',
    legalName: 'Demo Carrier',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: true
  });

  demoLoad = await Load.create({
    loadNumber: 'DEMO-LOAD-' + Date.now(),
    shipperName: 'Demo Shipper',
    origin: { city: 'Austin', state: 'TX' },
    destination: { city: 'Dallas', state: 'TX' },
    commodity: 'Dry Goods',
    equipmentType: 'DRY_VAN',
    declaredCargoValue: 100000,
    status: 'POSTED',
    isDemoData: true,
    ownershipResolved: true,
    ownershipResolution: 'DEMO'
  });
  productionLoad = await Load.create({
    company: companyA._id,
    loadNumber: 'PROD-LOAD-' + Date.now(),
    shipperName: 'Prod Shipper',
    origin: { city: 'Houston', state: 'TX' },
    destination: { city: 'Denver', state: 'CO' },
    commodity: 'Electronics',
    equipmentType: 'DRY_VAN',
    declaredCargoValue: 120000,
    status: 'POSTED',
    isDemoData: false,
    ownershipResolved: true,
    ownershipResolution: 'CREATED'
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

describe('Load Eligibility Tenant Security', () => {
  it('rejects unauthenticated eligibility requests', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${demoLoad._id}/eligibility/${demoCarrier._id}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  });

  it('rejects missing company context for authenticated users', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}` }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('denies cross-company carrier eligibility access', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${carrierB._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('enforces role permissions for company-scoped eligibility evaluation', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenViewerA}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'FORBIDDEN_ROLE');
  });

  it('allows authorized company-scoped eligibility for same-company carrier and non-demo load', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(String(body.carrier.id), String(carrierA._id));
    assert.equal(String(body.load.id), String(productionLoad._id));
    assert.ok(body.evaluation);
  });

  it('preserves explicit demo eligibility and enforces demo/production separation', async () => {
    const demoOk = await fetch(`${baseUrl}/api/loads/${demoLoad._id}/eligibility/${demoCarrier._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(demoOk.status, 200);
    assert.equal((await demoOk.json()).success, true);

    const demoProdCarrier = await fetch(`${baseUrl}/api/loads/${demoLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(demoProdCarrier.status, 403);
    assert.equal((await demoProdCarrier.json()).code, 'FORBIDDEN_TENANT_ACCESS');

    const demoProdLoad = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${demoCarrier._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Demo-Mode': 'true' }
    });
    assert.equal(demoProdLoad.status, 403);
    assert.equal((await demoProdLoad.json()).code, 'FORBIDDEN_TENANT_ACCESS');

    const companyDemoLoad = await fetch(`${baseUrl}/api/loads/${demoLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenBrokerA}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(companyDemoLoad.status, 403);
    assert.equal((await companyDemoLoad.json()).code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('denies access when company context membership is not valid for that company', async () => {
    const res = await fetch(`${baseUrl}/api/loads/${productionLoad._id}/eligibility/${carrierA._id}`, {
      headers: { Authorization: `Bearer ${tokenUserB}`, 'X-Company-Id': String(companyA._id) }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'NOT_A_MEMBER');
  });
});
