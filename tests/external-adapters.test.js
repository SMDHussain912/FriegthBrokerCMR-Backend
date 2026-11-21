const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_external_adapter_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let ownerId;
let ownerToken;
let companyA;

const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  assertTestDatabase();

  const passHash = await (require('../models/User')).hashPassword('AdapterOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'adapter-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'adapter-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Adapter Co A', slug: 'ada-' + Date.now(), type: 'brokerage', owner: ownerId,
  })).insertedId;

  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });

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

describe('External Adapters', () => {
  it('1. Lists all adapters with configuration status', async () => {
    const { status, json } = await getReq('/api/adapters', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.adapters));
    assert.ok(body.adapters.length >= 9);
    const adapterTypes = body.adapters.map((a) => a.adapter);
    assert.ok(adapterTypes.includes('fmcsa'));
    assert.ok(adapterTypes.includes('insurance'));
    assert.ok(adapterTypes.includes('gps_eld'));
    assert.ok(adapterTypes.includes('maps'));
    assert.ok(adapterTypes.includes('eta'));
    assert.ok(adapterTypes.includes('ocr'));
    assert.ok(adapterTypes.includes('accounting'));
    assert.ok(adapterTypes.includes('load_board'));
    assert.ok(adapterTypes.includes('webhook'));
  });

  it('2. Executes FMCSA adapter', async () => {
    const { status, json } = await req('/api/adapters/fmcsa/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'fmcsa',
        payload: { dotNumber: '123456', mcNumber: 'MC123456' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'fmcsa');
    assert.ok(body.data.dotNumber === '123456' || body.data.data.dotNumber === '123456');
  });

  it('3. Executes insurance adapter', async () => {
    const { status, json } = await req('/api/adapters/insurance/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'insurance',
        payload: { carrierId: String(new mongoose.Types.ObjectId()), policyNumber: 'POL123456' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'insurance');
  });

  it('4. Executes GPS/ELD adapter', async () => {
    const { status, json } = await req('/api/adapters/gps_eld/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'gps_eld',
        payload: { vehicleId: 'veh-001', carrierId: String(new mongoose.Types.ObjectId()) }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'gps_eld');
  });

  it('5. Executes maps adapter', async () => {
    const { status, json } = await req('/api/adapters/maps/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'maps',
        payload: { origin: 'Denver, CO', destination: 'Dallas, TX' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'maps');
  });

  it('6. Executes ETA adapter', async () => {
    const { status, json } = await req('/api/adapters/eta/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'eta',
        payload: { vehicleId: 'veh-001', destination: 'Dallas, TX' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'eta');
  });

  it('7. Executes OCR adapter', async () => {
    const { status, json } = await req('/api/adapters/ocr/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'ocr',
        payload: { documentId: 'doc-001', documentType: 'insurance_certificate' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'ocr');
  });

  it('8. Executes accounting adapter', async () => {
    const { status, json } = await req('/api/adapters/accounting/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'accounting',
        payload: { carrierId: String(new mongoose.Types.ObjectId()) }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'accounting');
  });

  it('9. Executes load board adapter', async () => {
    const { status, json } = await req('/api/adapters/load_board/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'load_board',
        payload: { origin: 'Denver, CO', destination: 'Dallas, TX', equipmentType: 'DRY_VAN' }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'load_board');
  });

  it('10. Executes webhook adapter', async () => {
    const { status, json } = await req('/api/adapters/webhook/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        adapterType: 'webhook',
        payload: { url: 'https://webhook.example.com/notify', payload: { test: true } }
      }
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.adapter, 'webhook');
  });

  it('11. Rejects unknown adapter type', async () => {
    const { status, json } = await req('/api/adapters/unknown_adapter/execute', ownerToken, {
      'X-Company-Id': String(companyA),
      body: { adapterType: 'unknown_adapter', payload: {} }
    });
    assert.equal(status, 400);
    const body = await json();
    assert.equal(body.code, 'INVALID_ADAPTER');
  });

  it('12. Rejects without company context', async () => {
    const { status, json } = await req('/api/adapters/fmcsa/execute', ownerToken, {
      body: { adapterType: 'fmcsa', payload: { dotNumber: '123456' } }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('13. Rejects demo mode', async () => {
    const { status, json } = await req('/api/adapters/fmcsa/execute', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { adapterType: 'fmcsa', payload: { dotNumber: '123456' } }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('14. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Adapter Co B', slug: 'adb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/adapters/fmcsa/execute', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { adapterType: 'fmcsa', payload: { dotNumber: '123456' } }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
