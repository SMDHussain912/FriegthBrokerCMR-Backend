const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_expense_test_' + process.pid;

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

  const passHash = await (require('../models/User')).hashPassword('ExpOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'exp-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'exp-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Expense Co A', slug: 'expa-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

  carrierId = (await insert('carriers', {
    company: companyA, dotNumber: 'EXP111111', mcNumber: 'MCEXP111111', legalName: 'Exp Carrier LLC',
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

describe('Expenses (Accessorial / Detention Charges)', () => {
  it('1. Creates an expense with line items', async () => {
    const { status, json } = await req('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        carrierId: String(carrierId),
        currency: 'USD',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        lineItems: [
          { description: 'Detention charge', category: 'detention', quantity: 2, unitPrice: 50 },
          { description: 'Fuel surcharge', category: 'fuel', quantity: 1, unitPrice: 120 }
        ],
        notes: 'Weekend detention'
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.expense.expenseNumber, 'expense number generated');
    assert.equal(body.expense.carrierId, String(carrierId));
    assert.equal(body.expense.status, 'draft');
    assert.equal(body.expense.amount, 220);
    assert.equal(body.expense.balanceDue(), 220);
    assert.equal(body.expense.lineItems.length, 2);
    assert.equal(body.expense.lineItems[0].amount, 100);
    assert.equal(body.expense.lineItems[1].amount, 120);
  });

  it('2. Lists expenses with pagination', async () => {
    const { status, json } = await getReq('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.total, 1);
    assert.equal(body.expenses.length, 1);
    assert.equal(body.expenses[0].expenseNumber, 'EXP-00001');
  });

  it('3. Gets a single expense', async () => {
    const { status, json } = await getReq('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const expId = json.expenses[0]._id;
    const g = await getReq(`/api/expenses/${expId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.expense.expenseNumber, 'EXP-00001');
    assert.equal(gb.expense.balanceDue(), 220);
  });

  it('4. Records a payment reducing balance due', async () => {
    const { status, json } = await getReq('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const expId = json.expenses[0]._id;
    const p = await req(`/api/expenses/${expId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 100 }
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.success, true);
    assert.equal(pb.expense.paidAmount, 100);
    assert.equal(pb.expense.balanceDue(), 120);
    assert.equal(pb.expense.status, 'draft');
  });

  it('5. Overpayment is rejected', async () => {
    const { status, json } = await getReq('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const expId = json.expenses[0]._id;
    const p = await req(`/api/expenses/${expId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 999999 }
    });
    assert.equal(p.status, 400);
    const pb = await p.json();
    assert.equal(pb.code, 'OVERPAYMENT');
  });

  it('6. Updates expense (paid -> void blocked)', async () => {
    const { status, json } = await getReq('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const expId = json.expenses[0]._id;
    // Mark paid via full payment
    await req(`/api/expenses/${expId}/payment`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { amount: 120 }
    });
    const u = await req(`/api/expenses/${expId}`, ownerToken, {
      'X-Company-Id': String(companyA),
      body: { notes: 'should fail - paid' }
    });
    assert.equal(u.status, 409);
    const ub = await u.json();
    assert.equal(ub.code, 'EXPENSE_PAID');
  });

  it('7. Voids a draft expense', async () => {
    const exp2 = (await insert('expenses', {
      company: companyA, carrierId: carrierId, expenseNumber: 'EXP-VOID-01',
      status: 'draft', currency: 'USD', amount: 100, paidAmount: 0,
      lineItems: [{ description: 'Void test', category: 'fuel', quantity: 1, unitPrice: 100 }],
      isDemoData: false,
    })).insertedId;
    const v = await req(`/api/expenses/${exp2}/void`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(v.status, 200);
    const vb = await v.json();
    assert.equal(vb.success, true);
    assert.equal(vb.expense.status, 'void');
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req('/api/expenses', ownerToken);
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req('/api/expenses', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { carrierId: String(carrierId), lineItems: [{ description: 'x', category: 'fuel', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Expense Co B', slug: 'expb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/expenses', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { carrierId: String(carrierId), lineItems: [{ description: 'x', category: 'fuel', quantity: 1, unitPrice: 1 }] }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
