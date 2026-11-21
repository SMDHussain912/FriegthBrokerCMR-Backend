const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_creditnote_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let companyA;
let customerId;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('CNOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'cn-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'cn-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Credit Note Co A', slug: 'cna-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  customerId = (await insert('customers', {
    company: companyA, name: 'Acme Shipping', type: 'customer', status: 'active',
    email: 'acme@example.com', paymentTerms: 'Net 30', creditLimit: 50000,
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

describe('Credit Notes', () => {
  it('1. Creates a credit note with line items', async () => {
    const { status, json } = await req('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        customer: String(customerId),
        currency: 'USD',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        reason: 'Billing dispute - overcharged on linehaul',
        lineItems: [
          { description: 'Linehaul overcharge', quantity: 1, unitPrice: 300 },
          { description: 'Accessorial credit', quantity: 1, unitPrice: 75 }
        ],
        notes: 'Customer disputed linehaul rate'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.creditNote.creditNoteNumber, 'credit note number generated');
    assert.equal(body.creditNote.customer, String(customerId));
    assert.equal(body.creditNote.status, 'draft');
    assert.equal(body.creditNote.amount, 375);
    assert.equal(body.creditNote.balanceDue(), 375);
    assert.equal(body.creditNote.lineItems.length, 2);
    assert.equal(body.creditNote.lineItems[0].amount, 300);
    assert.equal(body.creditNote.lineItems[1].amount, 75);
  });

  it('2. Lists credit notes with pagination', async () => {
    const { status, json } = await getReq('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.total, 1);
    assert.equal(body.creditNotes.length, 1);
    assert.equal(body.creditNotes[0].creditNoteNumber, 'CN-00001');
  });

  it('3. Gets a single credit note', async () => {
    const { status, json } = await getReq('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const cnId = json.creditNotes[0]._id;
    const g = await getReq(`/api/credit-notes/${cnId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.creditNote.creditNoteNumber, 'CN-00001');
    assert.equal(gb.creditNote.balanceDue(), 375);
  });

  it('4. Applies a credit note reducing balance due', async () => {
    const { status, json } = await getReq('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const cnId = json.creditNotes[0]._id;
    const p = await req(`/api/credit-notes/${cnId}/apply`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 150 }
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.success, true);
    assert.equal(pb.creditNote.appliedAmount, 150);
    assert.equal(pb.creditNote.balanceDue(), 225);
    assert.equal(pb.creditNote.status, 'draft');
  });

  it('5. Overapplication is rejected', async () => {
    const { status, json } = await getReq('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const cnId = json.creditNotes[0]._id;
    const p = await req(`/api/credit-notes/${cnId}/apply`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 999999 }
    });
    assert.equal(p.status, 400);
    const pb = await p.json();
    assert.equal(pb.code, 'OVERAPPLYMENT');
  });

  it('6. Updates credit note (applied -> void blocked)', async () => {
    const { status, json } = await getReq('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const cnId = json.creditNotes[0]._id;
    // Mark applied via full application
    await req(`/api/credit-notes/${cnId}/apply`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 225 }
    });
    const u = await req(`/api/credit-notes/${cnId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { notes: 'should fail - applied' }
    });
    assert.equal(u.status, 409);
    const ub = await u.json();
    assert.equal(ub.code, 'CREDIT_NOTE_APPLIED');
  });

  it('7. Voids a draft credit note', async () => {
    const cn2 = (await insert('creditNotes', {
      company: companyA, customer: customerId, creditNoteNumber: 'CN-VOID-01',
      status: 'draft', currency: 'USD', amount: 100, appliedAmount: 0,
      lineItems: [{ description: 'Void test', quantity: 1, unitPrice: 100 }],
      isDemoData: false,
    })).insertedId;
    const v = await req(`/api/credit-notes/${cn2}/void`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(v.status, 200);
    const vb = await v.json();
    assert.equal(vb.success, true);
    assert.equal(vb.creditNote.status, 'void');
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req('/api/credit-notes', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req('/api/credit-notes', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { customer: String(customerId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Credit Note Co B', slug: 'cnb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/credit-notes', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { customer: String(customerId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
