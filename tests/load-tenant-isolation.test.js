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
const { reconcileLoadTenancy } = require('../services/loadMigration');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_load_tenant_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerA, tokenA;
let brokerA, tokenABroker;
let viewerA, tokenAViewer;
let userB, tokenB;
let companyA, companyB;
let carrierA, carrierB, demoCarrier;
let loadA, loadB, legacyLoad, demoLoad;

const req = async (method, path, { token, companyId, demo = false, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers['X-Company-Id'] = String(companyId);
  if (demo) headers['X-Demo-Mode'] = 'true';
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, data };
};

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([Carrier.syncIndexes(), Company.syncIndexes(), Membership.syncIndexes(), User.syncIndexes(), Load.syncIndexes()]);

  const passHash = await User.hashPassword('Password123!');
  ownerA = await User.create({ name: 'Owner A', email: 'ownera@test.local', passwordHash: passHash, role: 'broker' });
  brokerA = await User.create({ name: 'Broker A', email: 'brokera@test.local', passwordHash: passHash, role: 'broker' });
  viewerA = await User.create({ name: 'Viewer A', email: 'viewera@test.local', passwordHash: passHash, role: 'broker' });
  userB = await User.create({ name: 'User B', email: 'userb@test.local', passwordHash: passHash, role: 'broker' });
  tokenA = signToken(ownerA);
  tokenABroker = signToken(brokerA);
  tokenAViewer = signToken(viewerA);
  tokenB = signToken(userB);

  companyA = await Company.create({ name: 'Company A', slug: 'comp-a-' + Date.now(), type: 'brokerage', owner: ownerA._id });
  companyB = await Company.create({ name: 'Company B', slug: 'comp-b-' + Date.now(), type: 'brokerage', owner: userB._id });

  await Membership.create({ user: ownerA._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: brokerA._id, company: companyA._id, role: 'broker', isActive: true });
  await Membership.create({ user: viewerA._id, company: companyA._id, role: 'viewer', isActive: true });
  await Membership.create({ user: userB._id, company: companyB._id, role: 'broker_owner', isActive: true });

  carrierA = await Carrier.create({ company: companyA._id, dotNumber: 'TA111111', mcNumber: 'MCTA111111', legalName: 'Tenant A Carrier', authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: false });
  carrierB = await Carrier.create({ company: companyB._id, dotNumber: 'TB222222', mcNumber: 'MCTB222222', legalName: 'Tenant B Carrier', authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: false });
  demoCarrier = await Carrier.create({ dotNumber: 'TD999999', mcNumber: 'MCTD999999', legalName: 'Demo Carrier', authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: true });

  loadA = await Load.create({ company: companyA._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'CREATED', loadNumber: 'A-001', shipperName: 'A Shipper', origin: { city: 'Austin', state: 'TX' }, destination: { city: 'Dallas', state: 'TX' }, commodity: 'Widgets', equipmentType: 'DRY_VAN', declaredCargoValue: 50000, status: 'POSTED' });
  loadB = await Load.create({ company: companyB._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'CREATED', loadNumber: 'B-001', shipperName: 'B Shipper', origin: { city: 'Denver', state: 'CO' }, destination: { city: 'Boise', state: 'ID' }, commodity: 'Parts', equipmentType: 'DRY_VAN', declaredCargoValue: 60000, status: 'POSTED' });
  legacyLoad = await Load.create({ isDemoData: false, ownershipResolved: false, ownershipResolution: 'UNRESOLVED', loadNumber: 'LEGACY-001', shipperName: 'Legacy', origin: { city: 'Miami', state: 'FL' }, destination: { city: 'Tampa', state: 'FL' }, commodity: 'Old', equipmentType: 'DRY_VAN', declaredCargoValue: 10000, status: 'POSTED' });
  demoLoad = await Load.create({ isDemoData: true, ownershipResolved: true, ownershipResolution: 'DEMO', loadNumber: 'DEMO-001', shipperName: 'Demo', origin: { city: 'LA', state: 'CA' }, destination: { city: 'SF', state: 'CA' }, commodity: 'Demo', equipmentType: 'DRY_VAN', declaredCargoValue: 20000, status: 'POSTED' });

  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
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

describe('Load Tenant Ownership Isolation (Task 1.2)', () => {
  it('Company A cannot read, update, delete, assign, or evaluate Company B loads', async () => {
    const read = await req('GET', `/api/loads/${loadB._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(read.res.status, 403);
    assert.equal(read.data.code, 'FORBIDDEN_TENANT_ACCESS');

    const list = await req('GET', '/api/loads', { token: tokenA, companyId: companyA._id });
    assert.equal(list.res.status, 200);
    assert.ok(list.data.loads.every((l) => String(l._id) !== String(loadB._id)));

    const update = await req('PATCH', `/api/loads/${loadB._id}`, { token: tokenA, companyId: companyA._id, body: { shipperName: 'Hacked' } });
    assert.equal(update.res.status, 403);

    const del = await req('DELETE', `/api/loads/${loadB._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(del.res.status, 403);

    const assign = await req('POST', `/api/loads/${loadB._id}/assign`, { token: tokenA, companyId: companyA._id, body: { carrierId: String(carrierA._id) } });
    assert.equal(assign.res.status, 403);

    const eligibility = await req('GET', `/api/loads/${loadB._id}/eligibility/${carrierA._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(eligibility.res.status, 403);
  });

  it('Company A cannot access unassigned legacy loads', async () => {
    const read = await req('GET', `/api/loads/${legacyLoad._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(read.res.status, 404);

    const update = await req('PATCH', `/api/loads/${legacyLoad._id}`, { token: tokenA, companyId: companyA._id, body: { shipperName: 'Nope' } });
    assert.equal(update.res.status, 404);

    const assign = await req('POST', `/api/loads/${legacyLoad._id}/assign`, { token: tokenA, companyId: companyA._id, body: { carrierId: String(carrierA._id) } });
    assert.equal(assign.res.status, 404);
  });

  it('Company-mode requests cannot access demo loads and demo mode cannot access production/company loads', async () => {
    const companyReadsDemo = await req('GET', `/api/loads/${demoLoad._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(companyReadsDemo.res.status, 403);

    const demoReadsCompany = await req('GET', `/api/loads/${loadA._id}`, { token: tokenA, demo: true });
    assert.equal(demoReadsCompany.res.status, 403);

    const demoList = await req('GET', '/api/loads', { token: tokenA, demo: true });
    assert.equal(demoList.res.status, 200);
    assert.ok(demoList.data.loads.every((l) => l.isDemoData === true));
    assert.ok(demoList.data.loads.every((l) => String(l._id) !== String(loadA._id)));
  });

  it('New loads are assigned to verified active company server-side and client company cannot override', async () => {
    const create = await req('POST', '/api/loads', {
      token: tokenA,
      companyId: companyA._id,
      body: {
        loadNumber: 'NEW-A-100',
        shipperName: 'New Shipper',
        origin: { city: 'Austin', state: 'TX' },
        destination: { city: 'Houston', state: 'TX' },
        commodity: 'Goods',
        equipmentType: 'DRY_VAN',
        declaredCargoValue: 12345,
        company: String(companyB._id),
        isDemoData: true,
        ownershipResolved: false,
        status: 'ASSIGNED'
      }
    });
    assert.equal(create.res.status, 400);
    assert.equal(create.data.code, 'INVALID_FIELDS');

    const ok = await req('POST', '/api/loads', {
      token: tokenA,
      companyId: companyA._id,
      body: {
        loadNumber: 'NEW-A-101',
        shipperName: 'New Shipper',
        origin: { city: 'Austin', state: 'TX' },
        destination: { city: 'Houston', state: 'TX' },
        commodity: 'Goods',
        equipmentType: 'DRY_VAN',
        declaredCargoValue: 12345
      }
    });
    assert.equal(ok.res.status, 201);
    assert.equal(String(ok.data.load.company), String(companyA._id));
    assert.equal(ok.data.load.isDemoData, false);
    assert.equal(ok.data.load.ownershipResolved, true);
    assert.equal(ok.data.load.ownershipResolution, 'CREATED');
    assert.equal(ok.data.load.status, 'POSTED');

    const crossRead = await req('GET', `/api/loads/${ok.data.load._id}`, { token: tokenB, companyId: companyB._id });
    assert.equal(crossRead.res.status, 403);
  });

  it('A load cannot be assigned to or evaluated against another company\'s carrier', async () => {
    const crossCarrierAssign = await req('POST', `/api/loads/${loadA._id}/assign`, { token: tokenA, companyId: companyA._id, body: { carrierId: String(carrierB._id) } });
    assert.equal(crossCarrierAssign.res.status, 403);

    const crossCarrierEval = await req('GET', `/api/loads/${loadA._id}/eligibility/${carrierB._id}`, { token: tokenA, companyId: companyA._id });
    assert.equal(crossCarrierEval.res.status, 403);

    const demoCross = await req('GET', `/api/loads/${demoLoad._id}/eligibility/${carrierA._id}`, { token: tokenA, demo: true });
    assert.equal(demoCross.res.status, 403);
  });

  it('Authorized roles can perform permitted operations and unauthorized roles are rejected', async () => {
    const viewerCreate = await req('POST', '/api/loads', {
      token: tokenAViewer, companyId: companyA._id,
      body: { loadNumber: 'VIEWER-1', shipperName: 'S', origin: { city: 'A', state: 'TX' }, destination: { city: 'B', state: 'TX' }, commodity: 'C', equipmentType: 'DRY_VAN', declaredCargoValue: 1 }
    });
    assert.equal(viewerCreate.res.status, 403);
    assert.equal(viewerCreate.data.code, 'FORBIDDEN_ROLE');

    const viewerRead = await req('GET', '/api/loads', { token: tokenAViewer, companyId: companyA._id });
    assert.equal(viewerRead.res.status, 200);

    const brokerCreate = await req('POST', '/api/loads', {
      token: tokenABroker, companyId: companyA._id,
      body: { loadNumber: 'BROKER-1', shipperName: 'S', origin: { city: 'A', state: 'TX' }, destination: { city: 'B', state: 'TX' }, commodity: 'C', equipmentType: 'DRY_VAN', declaredCargoValue: 1 }
    });
    assert.equal(brokerCreate.res.status, 201);
  });

  it('Load assignment read is tenant-scoped and demo/company separated', async () => {
    const companyReadDemoAssignment = await req('GET', `/api/loads/${demoLoad._id}/assignment`, { token: tokenA, companyId: companyA._id });
    assert.equal(companyReadDemoAssignment.res.status, 403);

    const demoReadCompanyAssignment = await req('GET', `/api/loads/${loadA._id}/assignment`, { token: tokenA, demo: true });
    assert.equal(demoReadCompanyAssignment.res.status, 403);
  });
});

describe('Load Ownership Migration (Task 1.2)', () => {
  it('dry-run reports unresolved records without modifying them', async () => {
    const probe = await Load.create({
      isDemoData: false, ownershipResolved: false, ownershipResolution: 'UNRESOLVED',
      loadNumber: 'LEGACY-PROBE-' + Date.now(), shipperName: 'Probe', origin: { city: 'X', state: 'TX' }, destination: { city: 'Y', state: 'TX' }, commodity: 'Z', equipmentType: 'DRY_VAN', declaredCargoValue: 1, status: 'POSTED'
    });
    const before = await Load.findById(probe._id).lean();
    const report = await reconcileLoadTenancy({ apply: false, logger: { info() {}, log() {} } });
    const after = await Load.findById(probe._id).lean();
    assert.equal(report.apply, false);
    assert.ok(report.unresolvedLegacy >= 1 || report.unresolvedLegacyAlreadyMarked >= 1);
    assert.equal(after.ownershipResolved, before.ownershipResolved);
    assert.equal(after.ownershipResolution, before.ownershipResolution);
    assert.equal(after.company || null, before.company || null);
  });

  it('migration is safe to run more than once (idempotent) and quarantines unresolved legacy loads', async () => {
    const demo = await Load.create({
      isDemoData: true, ownershipResolved: false, ownershipResolution: 'UNRESOLVED',
      loadNumber: 'DEMO-MIG-' + Date.now(), shipperName: 'DemoMig', origin: { city: 'A', state: 'TX' }, destination: { city: 'B', state: 'TX' }, commodity: 'D', equipmentType: 'DRY_VAN', declaredCargoValue: 1, status: 'POSTED'
    });
    const legacy = await Load.create({
      isDemoData: false,
      loadNumber: 'LEGACY-MIG-' + Date.now(), shipperName: 'LegacyMig', origin: { city: 'A', state: 'TX' }, destination: { city: 'B', state: 'TX' }, commodity: 'D', equipmentType: 'DRY_VAN', declaredCargoValue: 1, status: 'POSTED'
    });
    const owned = await Load.create({
      company: companyA._id, isDemoData: false, ownershipResolved: false, ownershipResolution: 'UNRESOLVED',
      loadNumber: 'OWNED-MIG-' + Date.now(), shipperName: 'OwnedMig', origin: { city: 'A', state: 'TX' }, destination: { city: 'B', state: 'TX' }, commodity: 'D', equipmentType: 'DRY_VAN', declaredCargoValue: 1, status: 'POSTED'
    });

    const first = await reconcileLoadTenancy({ apply: true, logger: { info() {}, log() {} } });
    assert.ok(first.mutated >= 1);
    const demoAfter = await Load.findById(demo._id);
    const legacyAfter = await Load.findById(legacy._id);
    const ownedAfter = await Load.findById(owned._id);
    assert.equal(demoAfter.ownershipResolved, true);
    assert.equal(demoAfter.ownershipResolution, 'DEMO');
    assert.equal(legacyAfter.ownershipResolved, false);
    assert.equal(legacyAfter.ownershipResolution, 'UNRESOLVED');
    assert.equal(legacyAfter.company || null, null);
    assert.equal(ownedAfter.ownershipResolved, true);
    assert.ok(['MIGRATED', 'CREATED', 'MANUAL'].includes(ownedAfter.ownershipResolution));

    const second = await reconcileLoadTenancy({ apply: true, logger: { info() {}, log() {} } });
    assert.equal(second.mutated, 0);
    const demoFinal = await Load.findById(demo._id);
    const legacyFinal = await Load.findById(legacy._id);
    assert.equal(demoFinal.ownershipResolution, 'DEMO');
    assert.equal(legacyFinal.ownershipResolved, false);
    assert.equal(legacyFinal.ownershipResolution, 'UNRESOLVED');
  });
});
