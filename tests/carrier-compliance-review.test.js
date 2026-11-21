const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_carrier_compliance_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;

// Raw insert helper: Mongoose model .create() hangs in single-file test runs
// (an environment quirk with the write path); raw collection writes work reliably.
const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

let owner, ownerToken;
let viewer, viewerToken;
let outsider, outsiderToken;
let companyA, companyB;

const NOW = new Date('2026-01-15T12:00:00.000Z');

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  // Users (role enum: broker | compliance_officer | admin)
  const ownerRes = await insert('users', {
    name: 'Owner', email: 'comp-owner@example.com',
    passwordHash: await (require('../models/User').hashPassword('Password123!')),
    role: 'broker'
  });
  const viewerRes = await insert('users', {
    name: 'Viewer', email: 'comp-viewer@example.com',
    passwordHash: await (require('../models/User').hashPassword('Password123!')),
    role: 'broker'
  });
  const outsiderRes = await insert('users', {
    name: 'Outsider', email: 'comp-outsider@example.com',
    passwordHash: await (require('../models/User').hashPassword('Password123!')),
    role: 'broker'
  });
  owner = { _id: ownerRes.insertedId, email: 'comp-owner@example.com', role: 'broker' };
  viewer = { _id: viewerRes.insertedId, email: 'comp-viewer@example.com', role: 'broker' };
  outsider = { _id: outsiderRes.insertedId, email: 'comp-outsider@example.com', role: 'broker' };
  ownerToken = signToken(owner);
  viewerToken = signToken(viewer);
  outsiderToken = signToken(outsider);

  companyA = (await insert('companies', {
    name: 'Compliance Co A', slug: 'cca-' + Date.now(), type: 'brokerage', owner: owner._id
  })).insertedId;
  companyB = (await insert('companies', {
    name: 'Compliance Co B', slug: 'ccb-' + Date.now(), type: 'brokerage', owner: outsider._id
  })).insertedId;

  await insert('memberships', { user: owner._id, company: companyA, role: 'broker_owner', isActive: true });
  await insert('memberships', { user: viewer._id, company: companyA, role: 'viewer', isActive: true });
  await insert('memberships', { user: outsider._id, company: companyB, role: 'broker_owner', isActive: true });

  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = 'http://localhost:' + server.address().port; resolve(); });
  });
});

after(async () => {
  try { await new Promise((resolve) => server.close(resolve)); } catch {}
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

const req = async (path, token, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }
  });
  return { res, status: res.status, json: async () => await res.json() };
};

const carrierDoc = (company, overrides = {}) => {
  const autoExpiration = overrides.autoExpiration || new Date('2027-01-01');
  return {
    company,
    dotNumber: overrides.dotNumber || '1000000',
    mcNumber: overrides.mcNumber || 'MC-1000000',
    legalName: overrides.legalName || 'Test Carrier LLC',
    authorityStatus: overrides.authorityStatus || 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Travelers',
        policyNumber: 'TRV-1',
        coverageLimit: 1000000,
        effectiveDate: new Date('2025-01-01'),
        expirationDate: autoExpiration,
        verificationStatus: overrides.autoVerification || 'VERIFIED'
      }
    ],
    overallStatus: overrides.overallStatus || 'PASS',
    isDemoData: false,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date()
  };
};

describe('Carrier Compliance Review Queue', () => {
  it('1. Requires authenticated company context (missing company header -> 403)', async () => {
    const { status, json } = await req('/api/carriers/compliance-review', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('2. Demo mode is denied (403 DEMO_NOT_ALLOWED)', async () => {
    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, { 'X-Demo-Mode': 'true' });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('3. Returns empty queue when all carriers are compliant', async () => {
    await insert('carriers', carrierDoc(companyA, { dotNumber: '1000001', mcNumber: 'MC-1000001' }));
    await insert('carriers', carrierDoc(companyA, { dotNumber: '1000002', mcNumber: 'MC-1000002' }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.reviewItems.length, 0);
    assert.equal(body.warningDays, 30);
  });

  it('4. Flags expired insurance as high severity insurance_expiry', async () => {
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '2000001', mcNumber: 'MC-2000001',
      autoExpiration: new Date('2025-06-01'), overallStatus: 'PASS'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    const expiryItems = body.reviewItems.filter((i) => i.type === 'insurance_expiry' && i.severity === 'high');
    assert.ok(expiryItems.length >= 1, 'expected at least one high insurance_expiry item');
    assert.ok(expiryItems[0].reason.includes('expired'));
    const carrier = await mongoose.connection.collection('carriers').findOne({ dotNumber: '2000001' });
    assert.equal(expiryItems[0].carrierId, String(carrier._id));
  });

  it('5. Flags insurance expiring within warning window', async () => {
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '2000002', mcNumber: 'MC-2000002',
      autoExpiration: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), overallStatus: 'PASS'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    const items = body.reviewItems.filter((i) => i.type === 'insurance_expiry' && i.dotNumber === '2000002');
    assert.equal(items.length, 1);
    assert.equal(items[0].severity, 'medium');
    assert.ok(items[0].reason.includes('expires in'));
  });

  it('6. Flags non-ACTIVE authority (REVOKED -> high)', async () => {
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '2000003', mcNumber: 'MC-2000003',
      authorityStatus: 'REVOKED', autoExpiration: new Date('2028-01-01'), overallStatus: 'PASS'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    const authItems = body.reviewItems.filter((i) => i.type === 'authority' && i.dotNumber === '2000003');
    assert.equal(authItems.length, 1);
    assert.equal(authItems[0].severity, 'high');
    assert.equal(authItems[0].reason, 'Operating authority is REVOKED');
  });

  it('7. Flags vetting FAIL as high severity vetting item', async () => {
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '2000004', mcNumber: 'MC-2000004',
      authorityStatus: 'ACTIVE', autoExpiration: new Date('2028-01-01'), overallStatus: 'FAIL'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    const vetItems = body.reviewItems.filter((i) => i.type === 'vetting' && i.dotNumber === '2000004');
    assert.equal(vetItems.length, 1);
    assert.equal(vetItems[0].severity, 'high');
    assert.equal(vetItems[0].overallStatus, 'FAIL');
  });

  it('8. Tenant isolation: company B carriers not returned for company A', async () => {
    await insert('carriers', carrierDoc(companyB, {
      dotNumber: '3000001', mcNumber: 'MC-3000001',
      authorityStatus: 'REVOKED', autoExpiration: new Date('2028-01-01'), overallStatus: 'PASS'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.ok(!body.reviewItems.some((i) => i.dotNumber === '3000001'), 'company B carrier must not leak into company A queue');
  });

  it('9. Viewer role can read the compliance queue', async () => {
    const { status, json } = await req('/api/carriers/compliance-review', viewerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.reviewItems));
  });

  it('10. Sorts high severity first', async () => {
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '4000001', mcNumber: 'MC-4000001',
      authorityStatus: 'REVOKED', autoExpiration: new Date('2028-01-01'), overallStatus: 'PASS'
    }));
    await insert('carriers', carrierDoc(companyA, {
      dotNumber: '4000002', mcNumber: 'MC-4000002',
      authorityStatus: 'INACTIVE', autoExpiration: new Date('2028-01-01'), overallStatus: 'PASS'
    }));

    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    // All high-severity items must sort before any medium-severity item.
    const severities = body.reviewItems.map((i) => i.severity);
    const lastHigh = severities.lastIndexOf('high');
    const firstMedium = severities.indexOf('medium');
    assert.ok(lastHigh === -1 || firstMedium === -1 || lastHigh < firstMedium);
    assert.ok(body.reviewItems.some((i) => i.dotNumber === '4000001' && i.severity === 'high'));
    assert.ok(body.reviewItems.some((i) => i.dotNumber === '4000002' && i.severity === 'medium'));
  });

  it('11. Cross-company read denied: company A member cannot read company B queue', async () => {
    const { status, json } = await req('/api/carriers/compliance-review', ownerToken, {
      'X-Company-Id': String(companyB)
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
