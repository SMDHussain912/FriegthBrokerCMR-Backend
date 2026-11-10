const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { reconcileCarrierTenancy } = require('../services/carrierMigration');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_carrier_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;

// Test fixtures
let user1, tokenUser1;
let user2, tokenUser2;
let companyA, companyB, companyC;
let membershipA1, membershipB1, membershipC1Inactive;
let membershipB2;
let carrierCompanyA, carrierCompanyB, demoCarrier;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();

  // Create test users
  const passHash = await User.hashPassword('Password123!');
  user1 = await User.create({
    name: 'Broker Alice',
    email: 'alice@example.com',
    passwordHash: passHash,
    role: 'compliance_officer'
  });
  tokenUser1 = signToken(user1);

  user2 = await User.create({
    name: 'Broker Bob',
    email: 'bob@example.com',
    passwordHash: passHash,
    role: 'broker'
  });
  tokenUser2 = signToken(user2);

  // Create companies
  companyA = await Company.create({
    name: 'Alpha Brokerage',
    slug: 'alpha-brokerage',
    type: 'brokerage',
    owner: user1._id
  });

  companyB = await Company.create({
    name: 'Beta Logistics',
    slug: 'beta-logistics',
    type: 'brokerage',
    owner: user2._id
  });

  companyC = await Company.create({
    name: 'Gamma Transport',
    slug: 'gamma-transport',
    type: 'brokerage',
    owner: user1._id
  });

  // User 1 has active membership in companyA and companyB, inactive in companyC
  membershipA1 = await Membership.create({
    user: user1._id,
    company: companyA._id,
    role: 'broker_owner',
    isActive: true
  });

  membershipB1 = await Membership.create({
    user: user1._id,
    company: companyB._id,
    role: 'compliance_officer',
    isActive: true
  });

  membershipC1Inactive = await Membership.create({
    user: user1._id,
    company: companyC._id,
    role: 'broker',
    isActive: false
  });

  // User 2 has active membership in companyB only
  membershipB2 = await Membership.create({
    user: user2._id,
    company: companyB._id,
    role: 'broker_owner',
    isActive: true
  });

  // Create test carriers
  carrierCompanyA = await Carrier.create({
    company: companyA._id,
    dotNumber: '1111111',
    mcNumber: 'MC-111111',
    legalName: 'Alpha Carrier LLC',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2020-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false,
    insurancePolicies: [
      {
        policyType: 'CARGO',
        insuranceProvider: 'Carrier Safe Ins',
        policyNumber: 'POL-ALPHA-1',
        coverageLimit: 250000,
        effectiveDate: new Date('2026-01-01'),
        expirationDate: new Date('2027-01-01'),
        verificationStatus: 'UNVERIFIED'
      }
    ]
  });

  carrierCompanyB = await Carrier.create({
    company: companyB._id,
    dotNumber: '2222222',
    mcNumber: 'MC-222222',
    legalName: 'Beta Haulers Inc',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2021-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: false,
    insurancePolicies: [
      {
        policyType: 'CARGO',
        insuranceProvider: 'Beta Protect',
        policyNumber: 'POL-BETA-1',
        coverageLimit: 300000,
        effectiveDate: new Date('2026-01-01'),
        expirationDate: new Date('2027-01-01'),
        verificationStatus: 'UNVERIFIED'
      }
    ]
  });

  demoCarrier = await Carrier.create({
    dotNumber: '9999999',
    mcNumber: 'MC-999999',
    legalName: 'Demo Showcase Carrier LLC',
    authorityStatus: 'ACTIVE',
    authorityGrantDate: new Date('2019-01-01'),
    safetyRating: 'SATISFACTORY',
    isDemoData: true,
    insurancePolicies: [
      {
        policyType: 'CARGO',
        insuranceProvider: 'Demo Insurance Co',
        policyNumber: 'POL-DEMO-1',
        coverageLimit: 100000,
        effectiveDate: new Date('2026-01-01'),
        expirationDate: new Date('2027-01-01'),
        verificationStatus: 'UNVERIFIED'
      }
    ]
  });

  // Start server on ephemeral port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  assertTestDatabase();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

describe('Carrier Tenant Isolation Security Tests', () => {

  it('1. Missing company context returns 403 on GET /api/carriers', async () => {
    const res = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('2. Missing membership returns 403 when user specifies company they do not belong to', async () => {
    // User 2 specifies Company A where they have NO membership
    const res = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser2}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'NOT_A_MEMBER');
  });

  it('3. Inactive membership returns 403', async () => {
    // User 1 specifies Company C where their membership is inactive
    const res = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyC._id)
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'MEMBERSHIP_INACTIVE');
  });

  it('4. Invalid company context returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': 'not-an-object-id'
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_COMPANY_CONTEXT');
  });

  it('5. User with multiple memberships returns only selected company carriers', async () => {
    // User 1 selects Company A
    const resA = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.success, true);
    assert.equal(bodyA.count, 1);
    assert.equal(bodyA.carriers[0].legalName, 'Alpha Carrier LLC');
    assert.equal(String(bodyA.carriers[0].company), String(companyA._id));

    // User 1 switches selection to Company B
    const resB = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyB._id)
      }
    });
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.success, true);
    assert.equal(bodyB.count, 1);
    assert.equal(bodyB.carriers[0].legalName, 'Beta Haulers Inc');
    assert.equal(String(bodyB.carriers[0].company), String(companyB._id));
  });

  it('6. Cross-company carrier retrieval by ID is denied with 403', async () => {
    // User 2 (in Company B) tries to fetch Carrier A (owned by Company A)
    const res = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}`, {
      headers: {
        Authorization: `Bearer ${tokenUser2}`,
        'X-Company-Id': String(companyB._id)
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('7. Cross-company carrier vetting evaluation is denied with 403', async () => {
    // User 2 (in Company B) tries to vet Carrier A (owned by Company A)
    const res = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}/vet`, {
      headers: {
        Authorization: `Bearer ${tokenUser2}`,
        'X-Company-Id': String(companyB._id)
      }
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('8. Cross-company policy verification is denied with 403', async () => {
    // User 1 (compliance_officer) with Company B active tries to verify a policy on Carrier A (Company A)
    const policyId = carrierCompanyA.insurancePolicies[0]._id;
    const res = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}/policies/${policyId}/verify`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyB._id)
      },
      body: JSON.stringify({
        status: 'VERIFIED',
        verificationNotes: 'Cross company attempt'
      })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('9. Policy verification on authorized company carrier succeeds and stamps audit identity', async () => {
    const policyId = carrierCompanyA.insurancePolicies[0]._id;
    const res = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}/policies/${policyId}/verify`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({
        status: 'VERIFIED',
        verificationNotes: 'Verified by compliance officer'
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.policy.verificationStatus, 'VERIFIED');
    assert.equal(body.policy.verifiedBy, user1.email);
    assert.ok(body.policy.verifiedAt);
  });

  it('10. Demo and production data remain isolated in company and explicit demo modes', async () => {
    const resWithoutDemo = await fetch(`${baseUrl}/api/carriers`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(resWithoutDemo.status, 200);
    const bodyWithoutDemo = await resWithoutDemo.json();
    assert.equal(bodyWithoutDemo.count, 1);
    assert.equal(bodyWithoutDemo.carriers[0].isDemoData, false);

    // A company-scoped query cannot be widened to include demo records.
    const resWithDemo = await fetch(`${baseUrl}/api/carriers?includeDemo=true`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(resWithDemo.status, 200);
    const bodyWithDemo = await resWithDemo.json();
    assert.equal(bodyWithDemo.count, 1);
    const ids = bodyWithDemo.carriers.map(c => String(c._id));
    assert.ok(ids.includes(String(carrierCompanyA._id)));
    assert.ok(!ids.includes(String(demoCarrier._id)));
    // Company B carrier must NEVER be included
    assert.ok(!ids.includes(String(carrierCompanyB._id)));

    const demoResponse = await fetch(`${baseUrl}/api/carriers?demo=true`);
    assert.equal(demoResponse.status, 200);
    const demoBody = await demoResponse.json();
    assert.equal(demoBody.count, 1);
    assert.equal(demoBody.carriers[0].isDemoData, true);

    const demoHeaders = {
      Authorization: `Bearer ${tokenUser1}`,
      'X-Demo-Mode': 'true'
    };
    const productionDetail = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}`, {
      headers: demoHeaders
    });
    assert.equal(productionDetail.status, 403);

    const productionVet = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}/vet`, {
      headers: demoHeaders
    });
    assert.equal(productionVet.status, 403);

    const productionPolicy = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}/policies/${carrierCompanyA.insurancePolicies[0]._id}/verify`, {
      method: 'PATCH',
      headers: { ...demoHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'VERIFIED' })
    });
    assert.equal(productionPolicy.status, 403);
  });

  it('11. Unauthenticated access to /api/carriers is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/carriers`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  it('12. Carrier search queries with regex characters are safely escaped (anti-ReDoS)', async () => {
    const res = await fetch(`${baseUrl}/api/carriers?query=(a+)+$`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 0); // Correctly treated as literal string, no crash or hanging
  });

  it('13. Carrier tenancy migration marks only reliably identified demo records', async () => {
    const demoDot = 'DEMO-' + new mongoose.Types.ObjectId().toString().slice(-7);
    const unownedDot = new mongoose.Types.ObjectId().toString().slice(-7);
    const companyDot = new mongoose.Types.ObjectId().toString().slice(-7);
    await Carrier.collection.insertMany([
      { dotNumber: demoDot, mcNumber: 'MIG-DEMO-' + demoDot, isDemoData: false },
      { dotNumber: unownedDot, mcNumber: 'MIG-UNOWNED-' + unownedDot },
      { company: companyA._id, dotNumber: companyDot, mcNumber: 'MIG-COMPANY-' + companyDot }
    ]);

    const result = await reconcileCarrierTenancy({ logger: { warn() {} } });
    const migratedDemo = await Carrier.collection.findOne({ dotNumber: demoDot });
    const unowned = await Carrier.collection.findOne({ dotNumber: unownedDot });
    const migratedCompany = await Carrier.collection.findOne({ dotNumber: companyDot });

    assert.equal(result.demoCarriersMarked, 1);
    assert.equal(result.unownedProductionCarriers, 1);
    assert.equal(migratedDemo.isDemoData, true);
    assert.equal(unowned.isDemoData, undefined);
    assert.equal(unowned.company, undefined);
    assert.equal(migratedCompany.isDemoData, false);
  });
});
