const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_invoice_test_' + process.pid;

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

  const passHash = await (require('../models/User')).hashPassword('InvOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'inv-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'inv-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Invoice Co A', slug: 'inva-' + Date.now(), type: 'brokerage', owner: ownerId,
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

describe('Customer Invoices', () => {
  it('1. Creates an invoice with line items', async () => {
    const { status, json } = await req('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        customer: String(customerId),
        currency: 'USD',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        lineItems: [
          { description: 'Linehaul Austin->Dallas', quantity: 1, unitPrice: 2500, loadNumber: 'LD-001' },
          { description: 'Fuel surcharge', quantity: 1, unitPrice: 150, loadNumber: 'LD-001' }
        ],
        notes: 'Monthly haulage'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.invoice.invoiceNumber, 'invoice number generated');
    assert.equal(body.invoice.customer, String(customerId));
    assert.equal(body.invoice.status, 'draft');
    assert.equal(body.invoice.amount, 2650);
    assert.equal(body.invoice.balanceDue(), 2650);
    assert.equal(body.invoice.lineItems.length, 2);
    assert.equal(body.invoice.lineItems[0].amount, 2500);
    assert.equal(body.invoice.lineItems[1].amount, 150);
  });

  it('2. Lists invoices with pagination', async () => {
    const { status, json } = await getReq('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.total, 1);
    assert.equal(body.invoices.length, 1);
    assert.equal(body.invoices[0].invoiceNumber, 'INV-00001');
  });

  it('3. Gets a single invoice', async () => {
    const { status, json } = await getReq('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const invId = json.invoices[0]._id;
    const g = await getReq(`/api/invoices/${invId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.invoice.invoiceNumber, 'INV-00001');
    assert.equal(gb.invoice.balanceDue(), 2650);
  });

  it('4. Records a payment reducing balance due', async () => {
    const { status, json } = await getReq('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const invId = json.invoices[0]._id;
    const p = await req(`/api/invoices/${invId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 1000 }
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.success, true);
    assert.equal(pb.invoice.paidAmount, 1000);
    assert.equal(pb.invoice.balanceDue(), 1650);
    assert.equal(pb.invoice.status, 'draft');
  });

  it('5. Overpayment is rejected', async () => {
    const { status, json } = await getReq('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const invId = json.invoices[0]._id;
    const p = await req(`/api/invoices/${invId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 999999 }
    });
    assert.equal(p.status, 400);
    const pb = await p.json();
    assert.equal(pb.code, 'OVERPAYMENT');
  });

  it('6. Updates invoice (paid -> void blocked)', async () => {
    const { status, json } = await getReq('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const invId = json.invoices[0]._id;
    // Mark paid via full payment
    await req(`/api/invoices/${invId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 1650 }
    });
    const u = await req(`/api/invoices/${invId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { notes: 'should fail - paid' }
    });
    assert.equal(u.status, 409);
    const ub = await u.json();
    assert.equal(ub.code, 'INVOICE_PAID');
  });

  it('7. Voids a draft invoice', async () => {
    const inv2 = (await insert('invoices', {
      company: companyA, customer: customerId, invoiceNumber: 'INV-VOID-01',
      status: 'draft', currency: 'USD', amount: 100, paidAmount: 0,
      lineItems: [{ description: 'Void test', quantity: 1, unitPrice: 100 }],
      isDemoData: false,
    })).insertedId;
    const v = await req(`/api/invoices/${inv2}/void`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(v.status, 200);
    const vb = await v.json();
    assert.equal(vb.success, true);
    assert.equal(vb.invoice.status, 'void');
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req('/api/invoices', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req('/api/invoices', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { customer: String(customerId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Invoice Co B', slug: 'invvb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/invoices', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { customer: String(customerId), lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
