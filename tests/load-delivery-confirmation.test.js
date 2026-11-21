const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Load = require('../models/Load');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_load_delivery_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let owner, token;
let companyA;
let loadId;
let carrierId;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await User.hashPassword('Password123!');
  const ownerRes = await insert('users', {
    name: 'Owner', email: 'dlv-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  owner = { _id: ownerRes.insertedId, email: 'dlv-owner@test.local', role: 'broker_owner' };
  token = signToken({ _id: owner._id, email: owner.email, role: owner.role });

  companyA = (await insert('companies', {
    name: 'Delivery Co A', slug: 'dlva-' + Date.now(), type: 'brokerage', owner: owner._id,
  })).insertedId;

  await insert('memberships', { user: owner._id, company: companyA, role: 'broker_owner', isActive: true });

  const carrierRes = await insert('carriers', {
    company: companyA, dotNumber: 'DLV111111', mcNumber: 'MCDLV111111', legalName: 'DLV Carrier LLC',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY',
    isDemoData: false,
  });
  carrierId = carrierRes.insertedId;

  const loadRes = await insert('loads', {
    company: companyA, loadNumber: 'DLV-001', shipperName: 'Shipper A',
    origin: { city: 'Austin', state: 'TX' },
    destination: { city: 'Dallas', state: 'TX' },
    commodity: 'Widgets', equipmentType: 'DRY_VAN', declaredCargoValue: 50000,
    status: 'DELIVERED', assignedCarrier: carrierId,
    isDemoData: false,
  });
  loadId = loadRes.insertedId;

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

describe('Proof of Delivery — Delivery Confirmation', () => {
  it('1. Confirms delivery and records proof (dispatch role)', async () => {
    const { status, json } = await req(`/api/tms/loads/${loadId}/delivery-confirmation`, token, {
      'X-Company-Id': String(companyA),
      body: { signedBy: 'Jane Driver', conditionAtDelivery: 'Good', notes: 'Left at dock' },
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.load.deliveryProof);
    assert.equal(body.load.deliveryProof.signedBy, 'Jane Driver');
    assert.equal(body.load.deliveryProof.conditionAtDelivery, 'Good');
    assert.ok(body.load.deliveryProof.confirmedAt);
    assert.equal(body.load.deliveryProof.confirmedBy, owner.email);
  });

  it('2. Rejects confirmation for non-DELIVERED load', async () => {
    const load2 = (await insert('loads', {
      company: companyA, loadNumber: 'DLV-002', shipperName: 'Shipper B',
      origin: { city: 'Austin', state: 'TX' },
      destination: { city: 'Dallas', state: 'TX' },
      commodity: 'Gadgets', equipmentType: 'DRY_VAN', declaredCargoValue: 10000,
      status: 'POSTED', isDemoData: false,
    })).insertedId;
    const { status, json } = await req(`/api/tms/loads/${load2}/delivery-confirmation`, token, {
      'X-Company-Id': String(companyA),
      body: { signedBy: 'X' },
    });
    assert.equal(status, 409);
    const body = await json();
    assert.equal(body.code, 'INVALID_LOAD_STATUS');
  });

  it('3. Rejects duplicate delivery confirmation', async () => {
    const { status, json } = await req(`/api/tms/loads/${loadId}/delivery-confirmation`, token, {
      'X-Company-Id': String(companyA),
      body: { signedBy: 'Again' },
    });
    assert.equal(status, 409);
    const body = await json();
    assert.equal(body.code, 'DELIVERY_ALREADY_CONFIRMED');
  });

  it('4. Rejects without company context', async () => {
    const { status, json } = await req(`/api/tms/loads/${loadId}/delivery-confirmation`, token);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('5. Rejects demo mode', async () => {
    const { status, json } = await req(`/api/tms/loads/${loadId}/delivery-confirmation`, token, {
      'X-Demo-Mode': 'true',
      body: { signedBy: 'Demo' },
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('6. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Delivery Co B', slug: 'dlvb-' + Date.now(), type: 'brokerage', owner: owner._id,
    })).insertedId;
    const { status, json } = await req(`/api/tms/loads/${loadId}/delivery-confirmation`, token, {
      'X-Company-Id': String(companyB),
      body: { signedBy: 'Nope' },
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
