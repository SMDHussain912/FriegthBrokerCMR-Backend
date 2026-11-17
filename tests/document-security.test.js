const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = require('../app');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Carrier = require('../models/Carrier');
const CarrierDocument = require('../models/CarrierDocument');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_document_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let tmpStorage;

let ownerA, brokerA, viewerA, userB;
let tokenOwnerA, tokenBrokerA, tokenViewerA, tokenB;
let companyA, companyB;
let carrierA, carrierB, demoCarrier;

const req = async (method, p, { token, companyId, demo = false, body, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (companyId) h['X-Company-Id'] = String(companyId);
  if (demo) h['X-Demo-Mode'] = 'true';
  const res = await fetch(baseUrl + p, {
    method,
    headers: h,
    body
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  }
  return { res, data, headers: res.headers };
};

function multipart(fields, file) {
  const boundary = '----fbcmrtest' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(Buffer.from(file.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

before(async () => {
  tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcmr-docs-'));
  process.env.STORAGE_PATH = tmpStorage;
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([
    Company.syncIndexes(), Membership.syncIndexes(), User.syncIndexes(),
    Carrier.syncIndexes(), CarrierDocument.syncIndexes()
  ]);

  const passHash = await User.hashPassword('Password123!');
  ownerA = await User.create({ name: 'Owner A', email: 'doc-owner-a@test.local', passwordHash: passHash, role: 'broker' });
  brokerA = await User.create({ name: 'Broker A', email: 'doc-broker-a@test.local', passwordHash: passHash, role: 'broker' });
  viewerA = await User.create({ name: 'Viewer A', email: 'doc-viewer-a@test.local', passwordHash: passHash, role: 'broker' });
  userB = await User.create({ name: 'User B', email: 'doc-user-b@test.local', passwordHash: passHash, role: 'broker' });
  tokenOwnerA = signToken(ownerA);
  tokenBrokerA = signToken(brokerA);
  tokenViewerA = signToken(viewerA);
  tokenB = signToken(userB);

  companyA = await Company.create({ name: 'Doc Co A', slug: 'doc-co-a-' + Date.now(), type: 'brokerage', owner: ownerA._id, createdBy: ownerA._id });
  companyB = await Company.create({ name: 'Doc Co B', slug: 'doc-co-b-' + Date.now(), type: 'brokerage', owner: userB._id, createdBy: userB._id });

  await Membership.create({ user: ownerA._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: brokerA._id, company: companyA._id, role: 'broker', isActive: true });
  await Membership.create({ user: viewerA._id, company: companyA._id, role: 'viewer', isActive: true });
  await Membership.create({ user: userB._id, company: companyB._id, role: 'broker_owner', isActive: true });

  carrierA = await Carrier.create({
    company: companyA._id, dotNumber: 'DOC111111', mcNumber: 'MCDOC111111', legalName: 'Doc Carrier A',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: false
  });
  carrierB = await Carrier.create({
    company: companyB._id, dotNumber: 'DOC222222', mcNumber: 'MCDOC222222', legalName: 'Doc Carrier B',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: false
  });
  demoCarrier = await Carrier.create({
    dotNumber: 'DOC999999', mcNumber: 'MCDOC999999', legalName: 'Demo Carrier',
    authorityStatus: 'ACTIVE', authorityGrantDate: new Date('2020-01-01'), safetyRating: 'SATISFACTORY', isDemoData: true
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assertTestDatabase();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
  try { fs.rmSync(tmpStorage, { recursive: true, force: true }); } catch {}
});

async function uploadForCompanyA({ token = tokenOwnerA, carrierId = carrierA._id, documentType = 'W9', content = 'hello-doc' } = {}) {
  const m = multipart({ documentType }, { filename: 'w9.txt', contentType: 'text/plain', content });
  return req('POST', `/api/carriers/${carrierId}/documents`, {
    token,
    companyId: companyA._id,
    headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}` },
    body: m.body
  });
}

describe('Document Security', () => {
  it('requires authentication and verified company context', async () => {
    const noAuth = await req('GET', `/api/carriers/${carrierA._id}/documents`);
    assert.equal(noAuth.res.status, 401);
    assert.equal(noAuth.data.code, 'AUTH_REQUIRED');

    const noCtx = await req('GET', `/api/carriers/${carrierA._id}/documents`, { token: tokenOwnerA });
    assert.equal(noCtx.res.status, 403);
    assert.equal(noCtx.data.code, 'COMPANY_CONTEXT_REQUIRED');

    const badId = await req('GET', `/api/carriers/${carrierA._id}/documents`, { token: tokenOwnerA, companyId: 'not-an-id' });
    assert.equal(badId.res.status, 403);
    assert.equal(badId.data.code, 'INVALID_COMPANY_CONTEXT');

    const notMember = await req('GET', `/api/carriers/${carrierA._id}/documents`, { token: tokenB, companyId: companyA._id });
    assert.equal(notMember.res.status, 403);
    assert.equal(notMember.data.code, 'NOT_A_MEMBER');
  });

  it('enforces company isolation for list, metadata, download and upload', async () => {
    const uploaded = await uploadForCompanyA();
    assert.equal(uploaded.res.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.success, true);
    const docId = uploaded.data.document._id || uploaded.data.document.id;
    assert.ok(docId);

    const crossList = await req('GET', `/api/carriers/${carrierA._id}/documents`, { token: tokenB, companyId: companyB._id });
    assert.ok([403, 404].includes(crossList.res.status));

    const crossMeta = await req('GET', `/api/carriers/${carrierA._id}/documents/${docId}`, { token: tokenB, companyId: companyB._id });
    assert.ok([403, 404].includes(crossMeta.res.status));

    const crossDownload = await req('GET', `/api/carriers/${carrierA._id}/documents/${docId}/download`, { token: tokenB, companyId: companyB._id });
    assert.ok([403, 404].includes(crossDownload.res.status));

    const crossUpload = await (async () => {
      const m = multipart({ documentType: 'W9' }, { filename: 'x.txt', contentType: 'text/plain', content: 'x' });
      return req('POST', `/api/carriers/${carrierA._id}/documents`, {
        token: tokenB, companyId: companyB._id,
        headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}` },
        body: m.body
      });
    })();
    assert.ok([403, 404].includes(crossUpload.res.status));

    // ensure company A can still read/download its own
    const ownMeta = await req('GET', `/api/carriers/${carrierA._id}/documents/${docId}`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(ownMeta.res.status, 200);
    assert.equal(ownMeta.data.success, true);

    const ownDownload = await req('GET', `/api/carriers/${carrierA._id}/documents/${docId}/download`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(ownDownload.res.status, 200);
  });

  it('enforces role permissions and demo/production separation', async () => {
    // viewer in company A should not be allowed to upload (broker/broker_owner/admin roles required for create)
    const viewerUpload = await uploadForCompanyA({ token: tokenViewerA });
    assert.ok([401, 403].includes(viewerUpload.res.status), `expected 401/403 got ${viewerUpload.res.status}`);

    // demo mode is read-only for company document operations in service
    const demoUpload = await (async () => {
      const m = multipart({ documentType: 'W9' }, { filename: 'demo.txt', contentType: 'text/plain', content: 'd' });
      return req('POST', `/api/carriers/${demoCarrier._id}/documents`, {
        token: tokenOwnerA, demo: true,
        headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}` },
        body: m.body
      });
    })();
    assert.ok([400, 401, 403, 404].includes(demoUpload.res.status), `expected demo denied got ${demoUpload.res.status}`);

    const demoList = await req('GET', `/api/carriers/${carrierA._id}/documents`, { token: tokenOwnerA, demo: true });
    assert.ok([400, 401, 403, 404].includes(demoList.res.status), `demo/company separation expected, got ${demoList.res.status}`);
  });

  it('rejects invalid IDs and missing resources safely', async () => {
    const badCarrier = await req('GET', `/api/carriers/not-a-valid-id/documents`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(badCarrier.res.status, 400);

    const uploaded = await uploadForCompanyA({ token: tokenBrokerA, content: 'x2' });
    assert.equal(uploaded.res.status, 201);
    const docId = uploaded.data.document._id || uploaded.data.document.id;

    const badDoc = await req('GET', `/api/carriers/${carrierA._id}/documents/not-a-valid-id`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(badDoc.res.status, 400);

    const missing = await req('GET', `/api/carriers/${carrierA._id}/documents/507f1f77bcf86cd799439011`, { token: tokenOwnerA, companyId: companyA._id });
    assert.ok([403, 404].includes(missing.res.status));

    const badDownload = await req('GET', `/api/carriers/${carrierA._id}/documents/not-a-valid-id/download`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(badDownload.res.status, 400);

    // sanity: valid download still works
    const ok = await req('GET', `/api/carriers/${carrierA._id}/documents/${docId}/download`, { token: tokenOwnerA, companyId: companyA._id });
    assert.equal(ok.res.status, 200);
  });
});
