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
let createdCarrier;

before(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Carrier.syncIndexes();

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

  it('13. Carrier creation validates required fields and derives ownership from the verified company', async () => {
    const invalid = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ legalName: 'Missing identifiers' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'REQUIRED_FIELD');

    const response = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({
        dotNumber: ' 3333333 ',
        mcNumber: ' mc-333333 ',
        legalName: 'Created CRM Carrier',
        dbaName: 'Created Carrier',
        authorityGrantDate: '2022-05-01',
        company: String(companyB._id),
        isDemoData: true,
        overallStatus: 'PASS'
      })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_FIELDS');

    const validResponse = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({
        dotNumber: ' 3333333 ',
        mcNumber: ' mc-333333 ',
        legalName: 'Created CRM Carrier',
        dbaName: 'Created Carrier',
        authorityGrantDate: '2022-05-01',
        contact: { email: 'OPS@EXAMPLE.COM' }
      })
    });
    assert.equal(validResponse.status, 201);
    const body = await validResponse.json();
    createdCarrier = body.carrier;
    assert.equal(createdCarrier.company, String(companyA._id));
    assert.equal(createdCarrier.isDemoData, false);
    assert.equal(createdCarrier.dotNumber, '3333333');
    assert.equal(createdCarrier.mcNumber, 'MC-333333');
    assert.equal(createdCarrier.contact.email, 'ops@example.com');
    assert.equal(Object.prototype.hasOwnProperty.call(createdCarrier, 'auditLog'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(createdCarrier, 'createdBy'), false);

    const detail = await fetch(`${baseUrl}/api/carriers/${createdCarrier._id}`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).carrier.legalName, 'Created CRM Carrier');
  });

  it('14. Duplicate DOT and MC identifiers conflict within a company', async () => {
    for (const duplicate of [
      { dotNumber: '3333333', mcNumber: 'MC-OTHER-333' },
      { dotNumber: 'OTHER-333333', mcNumber: 'MC-333333' }
    ]) {
      const response = await fetch(`${baseUrl}/api/carriers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUser1}`,
          'X-Company-Id': String(companyA._id)
        },
        body: JSON.stringify({
          ...duplicate,
          legalName: 'Duplicate Carrier',
          authorityGrantDate: '2020-01-01'
        })
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'DUPLICATE_CARRIER_IDENTIFIER');
    }
  });

  it('15. Carrier updates enforce tenant and role boundaries and keep audit private', async () => {
    const crossCompany = await fetch(`${baseUrl}/api/carriers/${carrierCompanyA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser2}`,
        'X-Company-Id': String(companyB._id)
      },
      body: JSON.stringify({ legalName: 'Unauthorized Update' })
    });
    assert.equal(crossCompany.status, 403);
    assert.equal((await crossCompany.json()).code, 'FORBIDDEN_TENANT_ACCESS');

    const roleDenied = await fetch(`${baseUrl}/api/carriers/${carrierCompanyB._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyB._id)
      },
      body: JSON.stringify({ legalName: 'Compliance Cannot Edit CRM' })
    });
    assert.equal(roleDenied.status, 403);
    assert.equal((await roleDenied.json()).code, 'FORBIDDEN_CARRIER_ROLE');

    const protectedUpdate = await fetch(`${baseUrl}/api/carriers/${createdCarrier._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ company: String(companyB._id), isDemoData: true, legalName: 'Spoofed' })
    });
    assert.equal(protectedUpdate.status, 400);
    assert.equal((await protectedUpdate.json()).code, 'INVALID_FIELDS');

    const updated = await fetch(`${baseUrl}/api/carriers/${createdCarrier._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ legalName: 'Updated CRM Carrier' })
    });
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.carrier.legalName, 'Updated CRM Carrier');
    assert.equal(Object.prototype.hasOwnProperty.call(updatedBody.carrier, 'auditLog'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(updatedBody.carrier, 'uploadedDocumentUri'), false);
  });

  it('16. Carrier list supports search, filters, sorting and pagination within tenant', async () => {
    const response = await fetch(`${baseUrl}/api/carriers?query=Updated%20CRM&authorityStatus=ACTIVE&status=UNKNOWN&page=1&limit=1&sortBy=legalName&sortOrder=desc`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 1);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 1);
    assert.equal(body.carriers[0].legalName, 'Updated CRM Carrier');
  });

  it('17. Demo CRUD and missing-context writes are denied', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dotNumber: '4444444', mcNumber: 'MC-444444', legalName: 'Unauthenticated', authorityGrantDate: '2021-01-01' })
    });
    assert.equal(unauthenticated.status, 401);

    const demoWrite = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Demo-Mode': 'true'
      },
      body: JSON.stringify({ dotNumber: '4444444', mcNumber: 'MC-444444', legalName: 'Demo Write', authorityGrantDate: '2021-01-01' })
    });
    assert.equal(demoWrite.status, 403);
    assert.equal((await demoWrite.json()).code, 'DEMO_READ_ONLY');

    const missingContext = await fetch(`${baseUrl}/api/carriers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenUser1}` },
      body: JSON.stringify({ dotNumber: '4444444', mcNumber: 'MC-444444', legalName: 'No Context', authorityGrantDate: '2021-01-01' })
    });
    assert.equal(missingContext.status, 403);
    assert.equal((await missingContext.json()).code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('18. Archive preserves the carrier and audit history but hides it from ordinary reads', async () => {
    const archived = await fetch(`${baseUrl}/api/carriers/${createdCarrier._id}/archive`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      },
      body: JSON.stringify({ reason: 'Duplicate CRM record' })
    });
    assert.equal(archived.status, 200);
    const archivedBody = await archived.json();
    assert.equal(archivedBody.carrier.isArchived, true);
    assert.equal(Object.prototype.hasOwnProperty.call(archivedBody.carrier, 'archiveReason'), false);

    const stored = await Carrier.findById(createdCarrier._id).select('+auditLog');
    assert.ok(stored);
    assert.equal(stored.isArchived, true);
    assert.deepEqual(stored.auditLog.map((entry) => entry.action), ['CREATED', 'UPDATED', 'ARCHIVED']);
    assert.equal(stored.auditLog[2].reason, 'Duplicate CRM record');

    const hidden = await fetch(`${baseUrl}/api/carriers/${createdCarrier._id}`, {
      headers: {
        Authorization: `Bearer ${tokenUser1}`,
        'X-Company-Id': String(companyA._id)
      }
    });
    assert.equal(hidden.status, 404);
    assert.equal((await Carrier.findById(createdCarrier._id)).isArchived, true);
  });

  it('19. Carrier tenancy migration marks only reliably identified demo records', async () => {
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
