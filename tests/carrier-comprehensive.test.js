const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_carrier_full_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let companyA;
let carrierId;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('CarrierOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'carrier-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'carrier-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Carrier Co A', slug: 'carra-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  carrierId = (await insert('carriers', {
    company: companyA, dotNumber: 'CAR111111', mcNumber: 'MCCAR111111', legalName: 'Carrier LLC',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY',
    isDemoData: false,
    contacts: [],
    equipment: [],
    drivers: []
  })).insertedId;

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

const getReq = async (path, token, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
  });
  return { res, status: res.status, json: async () => await res.json() };
};

describe('Carrier Contacts, Equipment, Drivers', () => {
  it('1. Adds a contact to a carrier', async () => {
    const { status, json } = await req(`/api/carriers/${carrierId}/contacts`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        name: 'John Smith',
        title: 'Operations Manager',
        phone: '555-123-4567',
        email: 'john.smith@carrier.com',
        mobile: '555-987-6543',
        department: 'Operations',
        isPrimary: true
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.contact._id, 'contact id generated');
    assert.equal(body.contact.name, 'John Smith');
    assert.equal(body.contact.title, 'Operations Manager');
    assert.equal(body.contact.isPrimary, true);
  });

  it('2. Lists contacts via carrier detail', async () => {
    const { status, json } = await getReq(`/api/carriers/${carrierId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.carrier.contacts));
    assert.equal(body.carrier.contacts.length, 1);
    assert.equal(body.carrier.contacts[0].name, 'John Smith');
  });

  it('3. Updates a contact', async () => {
    const { status, json } = await getReq(`/api/carriers/${carrierId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const contactId = json.carrier.contacts[0]._id;
    const u = await req(`/api/carriers/${carrierId}/contacts/${contactId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { phone: '555-111-2222', department: 'Logistics' }
    });
    assert.equal(u.status, 200);
    const ub = await u.json();
    assert.equal(ub.success, true);
    assert.equal(ub.contact.phone, '555-111-2222');
    assert.equal(ub.contact.department, 'Logistics');
    assert.equal(ub.contact.name, 'John Smith');
  });

  it('4. Adds equipment to a carrier', async () => {
    const { status, json } = await req(`/api/carriers/${carrierId}/equipment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        type: 'tractor',
        unitNumber: 'TR-001',
        vin: '1HGCM82633A123456',
        licensePlate: 'TRK-001',
        state: 'TX',
        year: 2020,
        make: 'Freightliner',
        model: 'Cascadia',
        status: 'active'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.equipment._id, 'equipment id generated');
    assert.equal(body.equipment.unitNumber, 'TR-001');
    assert.equal(body.equipment.type, 'tractor');
    assert.equal(body.equipment.make, 'Freightliner');
  });

  it('5. Adds a driver to a carrier', async () => {
    const { status, json } = await req(`/api/carriers/${carrierId}/drivers`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        name: 'Jane Driver',
        cdlNumber: 'CDL123456789',
        cdlClass: 'A',
        phone: '555-222-3333',
        email: 'jane.driver@carrier.com',
        isOwnerOperator: false
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.driver._id, 'driver id generated');
    assert.equal(body.driver.name, 'Jane Driver');
    assert.equal(body.driver.cdlNumber, 'CDL123456789');
    assert.equal(body.driver.cdlClass, 'A');
  });

  it('6. Updates driver status', async () => {
    const { status, json } = await getReq(`/api/carriers/${carrierId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const driverId = json.carrier.drivers[0]._id;
    const u = await req(`/api/carriers/${carrierId}/drivers/${driverId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { status: 'on_leave', medicalExpiration: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() }
    });
    assert.equal(u.status, 200);
    const ub = await u.json();
    assert.equal(ub.success, true);
    assert.equal(ub.driver.status, 'on_leave');
    assert.ok(ub.driver.medicalExpiration);
  });

  it('7. Deletes a contact', async () => {
    const { status, json } = await getReq(`/api/carriers/${carrierId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const contactId = json.carrier.contacts[0]._id;
    const d = await req(`/api/carriers/${carrierId}/contacts/${contactId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(d.status, 200);
    const db = await d.json();
    assert.equal(db.success, true);
    const g = await getReq(`/api/carriers/${carrierId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const gb = await g.json();
    assert.ok(!gb.carrier.contacts.some((c) => String(c._id) === String(contactId)));
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req(`/api/carriers/${carrierId}/contacts`, ownerToken, {
      body: { name: 'Test', title: 'Mgr' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req(`/api/carriers/${carrierId}/contacts`, ownerToken, {
      'X-Demo-Mode': 'true',
      body: { name: 'Demo', title: 'Mgr' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Carrier Co B', slug: 'carrb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req(`/api/carriers/${carrierId}/contacts`, ownerToken, {
      'X-Company-Id': String(companyB),
      body: { name: 'Cross', title: 'Mgr' }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
