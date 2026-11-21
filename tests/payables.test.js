const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_payable_test_' + process.pid;

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

  const passHash = await (require('../models/User')).hashPassword('PayOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'pay-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'pay-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Pay Co A', slug: 'paya-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  carrierId = (await insert('carriers', {
    company: companyA, dotNumber: 'PAY111111', mcNumber: 'MCPAY111111', legalName: 'Pay Carrier LLC',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY',
    isDemoData: false,
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

describe('Carrier Payables', () => {
  it('1. Creates a payable with line items', async () => {
    const { status, json } = await req('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        carrier: String(carrierId),
        currency: 'USD',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        lineItems: [
          { description: 'Linehaul Austin->Dallas', quantity: 1, unitPrice: 2000, loadNumber: 'LD-001' },
          { description: 'Detention', quantity: 2, unitPrice: 50, loadNumber: 'LD-001' }
        ],
        notes: 'Weekly carrier settlement'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.payable.payableNumber, 'payable number generated');
    assert.equal(body.payable.carrier, String(carrierId));
    assert.equal(body.payable.status, 'draft');
    assert.equal(body.payable.amount, 2100);
    assert.equal(body.payable.balanceDue(), 2100);
    assert.equal(body.payable.lineItems.length, 2);
    assert.equal(body.payable.lineItems[0].amount, 2000);
    assert.equal(body.payable.lineItems[1].amount, 100);
  });

  it('2. Lists payables with pagination', async () => {
    const { status, json } = await getReq('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.total, 1);
    assert.equal(body.payables.length, 1);
    assert.equal(body.payables[0].payableNumber, 'PAY-00001');
  });

  it('3. Gets a single payable', async () => {
    const { status, json } = await getReq('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const payId = json.payables[0]._id;
    const g = await getReq(`/api/payables/${payId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.payable.payableNumber, 'PAY-00001');
    assert.equal(gb.payable.balanceDue(), 2100);
  });

  it('4. Records a carrier payment reducing balance due', async () => {
    const { status, json } = await getReq('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const payId = json.payables[0]._id;
    const p = await req(`/api/payables/${payId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 800 }
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.success, true);
    assert.equal(pb.payable.paidAmount, 800);
    assert.equal(pb.payable.balanceDue(), 1300);
    assert.equal(pb.payable.status, 'draft');
  });

  it('5. Overpayment is rejected', async () => {
    const { status, json } = await getReq('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const payId = json.payables[0]._id;
    const p = await req(`/api/payables/${payId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 999999 }
    });
    assert.equal(p.status, 400);
    const pb = await p.json();
    assert.equal(pb.code, 'OVERPAYMENT');
  });

  it('6. Updates payable (paid -> void blocked)', async () => {
    const { status, json } = await getReq('/api/payables', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const payId = json.payables[0]._id;
    // Mark paid via full payment
    await req(`/api/payables/${payId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 1300 }
    });
    const u = await req(`/api/payables/${payId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { notes: 'should fail - paid' }
    });
    assert.equal(u.status, 409);
    const ub = await u.json();
    assert.equal(ub.code, 'PAYABLE_PAID');
  });

  it('7. Voids a draft payable', async () => {
    const pay2 = (await insert('payables', {
      company: companyA, carrier: carrierId, payableNumber: 'PAY-VOID-01',
      status: 'draft', currency: 'USD', amount: 100, paidAmount: 0,
      lineItems: [{ description: 'Void test', quantity: 1, unitPrice: 100 }],
      isDemoData: false,
    })).insertedId;
    const v = await req(`/api/payables/${pay2}/void`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(v.status, 200);
    const vb = await v.json();
    assert.equal(vb.success, true);
    assert.equal(vb.payable.status, 'void');
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req('/api/payables', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req('/api/payables', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { carrier: String(carrierId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Pay Co B', slug: 'payb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/payables', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { carrier: String(carrierId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
