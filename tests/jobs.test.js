const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_job_test_' + process.pid;

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

  const passHash = await (require('../models/User')).hashPassword('JobOwner123!');
  const uRes = await insert('users', {
    name: 'Owner', email: 'job-owner@test.local', passwordHash: passHash, role: 'broker_owner',
  });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'job-owner@test.local', role: 'broker_owner' });

  companyA = (await insert('companies', {
    name: 'Job Co A', slug: 'joba-' + Date.now(), type: 'brokerage', owner: ownerId,
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

describe('Background Jobs', () => {
  it('1. Enqueues a job', async () => {
    const { status, json } = await req('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        type: 'send_email',
        payload: { to: 'user@example.com', subject: 'Hello', body: 'Test email' },
        maxRetries: 3,
        retryDelayMs: 1000
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.job._id, 'job id generated');
    assert.equal(body.job.type, 'send_email');
    assert.equal(body.job.status, 'pending');
    assert.equal(body.job.maxRetries, 3);
    assert.equal(body.job.payload.to, 'user@example.com');
    assert.equal(body.fromCache, false);
  });

  it('2. Idempotency - same key returns existing pending job', async () => {
    const { status, json } = await req('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        type: 'send_email',
        idempotencyKey: 'idem-key-001',
        payload: { to: 'user@example.com', subject: 'Hello', body: 'Test email' }
      }
    });
    assert.equal(status, 201);
    const body = await json();
    assert.equal(body.success, true);
    assert.equal(body.fromCache, true);

    // Second call with same idempotency key should return cached job
    const { status: s2, json: j2 } = await req('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyA),
      body: {
        type: 'send_email',
        idempotencyKey: 'idem-key-001',
        payload: { to: 'user@example.com', subject: 'Hello', body: 'Test email' }
      }
    });
    assert.equal(s2.status, 201);
    assert.equal(j2.fromCache, true);
  });

  it('3. Lists jobs with pagination', async () => {
    const { status, json } = await getReq('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(status, 200);
    const body = await json();
    assert.equal(body.success, true);
    assert.ok(body.jobs.length >= 1);
    assert.ok(body.total >= 1);
    assert.ok(body.page);
    assert.ok(body.limit);
  });

  it('4. Gets a single job', async () => {
    const { status, json } = await getReq('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    const jobId = json.jobs[0]._id;
    const g = await getReq(`/api/jobs/${jobId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.equal(gb.success, true);
    assert.equal(gb.job._id, jobId);
    assert.equal(gb.job.status, 'pending');
  });

  it('5. Retries a failed job', async () => {
    // First create a failed job directly
    const failedJob = await insert('jobs', {
      company: companyA, type: 'test_failed', status: 'failed',
      payload: { test: true }, error: 'Something went wrong',
      retryCount: 0, maxRetries: 3, retryDelayMs: 1000,
      scheduledAt: new Date(), isDemoData: false
    });
    const r = await req(`/api/jobs/${failedJob.insertedId}/retry`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(r.status, 200);
    const rb = await r.json();
    assert.equal(rb.success, true);
    assert.equal(rb.job.status, 'pending');
    assert.equal(rb.job.retryCount, 1);
  });

  it('6. Cancels a pending job', async () => {
    const cancelJob = await insert('jobs', {
      company: companyA, type: 'test_cancel', status: 'pending',
      payload: { test: true }, retryCount: 0, maxRetries: 3,
      retryDelayMs: 1000, scheduledAt: new Date(), isDemoData: false
    });
    const c = await req(`/api/jobs/${cancelJob.insertedId}`, ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(c.status, 200);
    const cb = await c.json();
    assert.equal(cb.success, true);
    assert.equal(cb.job.status, 'cancelled');
  });

  it('7. Processes due jobs', async () => {
    // Create a pending job scheduled in the past
    await insert('jobs', {
      company: companyA, type: 'test_process', status: 'pending',
      payload: { test: true }, retryCount: 0, maxRetries: 3,
      retryDelayMs: 1000, scheduledAt: new Date(Date.now() - 60000), isDemoData: false
    });
    const p = await req('/api/jobs/process-due', ownerToken, {
      'X-Company-Id': String(companyA)
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.success, true);
    assert.ok(Array.isArray(pb.processed));
    assert.ok(pb.processed.length >= 1);
    assert.equal(pb.processed[0].status, 'running');
  });

  it('8. Rejects without company context', async () => {
    const { status, json } = await req('/api/jobs', ownerToken, {
      body: { type: 'test', payload: {} }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'COMPANY_CONTEXT_REQUIRED');
  });

  it('9. Rejects demo mode', async () => {
    const { status, json } = await req('/api/jobs', ownerToken, {
      'X-Demo-Mode': 'true',
      body: { type: 'test', payload: {} }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.equal(body.code, 'DEMO_NOT_ALLOWED');
  });

  it('10. Cross-company denied', async () => {
    const companyB = (await insert('companies', {
      name: 'Job Co B', slug: 'jobb-' + Date.now(), type: 'brokerage', owner: ownerId,
    })).insertedId;
    const { status, json } = await req('/api/jobs', ownerToken, {
      'X-Company-Id': String(companyB),
      body: { type: 'test', payload: {} }
    });
    assert.equal(status, 403);
    const body = await json();
    assert.ok(['NOT_A_MEMBER', 'FORBIDDEN_TENANT_ACCESS', 'COMPANY_CONTEXT_REQUIRED'].includes(body.code));
  });
});
