const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Load = require('../models/Load');
const User = require('../models/User');
const CarrierAssignment = require('../models/CarrierAssignment');
const { decideAssignment } = require('../services/assignmentService');
const { persistAssignmentConsistently } = require('../services/assignmentService');
const { DEMO_CARRIERS, DEMO_LOADS } = require('../services/mockData/fmcsaDemoData');
const { dropTestDatabase } = require('./helpers/testDb');

// Isolated DB + guard: cleanup refuses non-test databases (hygiene M4).
// The DB name carries the PID so that two test processes (e.g. a parallel
// CI matrix or a developer running the suite twice) can never share state.
const TEST_DB_URI = process.env.ASSIGNMENT_TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_assignment_test_' + process.pid;
const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let suffix = 0;
let brokerToken;
let complianceToken;
let adminToken;

const reqJSON = async (method, url, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers.Authorization = 'Bearer ' + token; }
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { res, data };
};

const createReeferLoad = async (tag) => {
  suffix += 1;
  return Load.create({
    loadNumber: 'TEST-' + tag + '-' + Date.now() + '-' + suffix + '-' + Math.floor(Math.random() * 100000),
    shipperName: 'Test Shipper (Demo)',
    origin: { city: 'Salinas', state: 'CA' },
    destination: { city: 'Chicago', state: 'IL' },
    commodity: 'Fresh Organic Strawberries (Demo)',
    equipmentType: 'REEFER',
    targetTemperature: 34,
    declaredCargoValue: 200000,
    loadRequirements: { minAuthorityAgeDays: 90, minAutoLiability: 1000000, requireReeferEndorsement: true, disallowConditionalSafety: true, maxUnsafeDrivingPercentile: 75 },
    status: 'POSTED',
    isDemoData: true
  });
};

const login = async (email, password) => {
  const { res, data } = await reqJSON('POST', baseUrl + '/api/auth/login', { email, password });
  assert.equal(res.status, 200, 'login must succeed for ' + email);
  assert.ok(data.token, 'login returns JWT');
  return data.token;
};

before(async () => {
  if (mongoose.connection.readyState !== 0) { await mongoose.connection.close(); }
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await CarrierAssignment.syncIndexes();
  await Carrier.deleteMany({ isDemoData: true });
  await Load.deleteMany({ isDemoData: true });
  await User.deleteMany({ isDemoData: true });
  await CarrierAssignment.deleteMany({ isDemoData: true });
  await Carrier.insertMany(DEMO_CARRIERS);
  await Load.insertMany(DEMO_LOADS);
  const mk = async (name, email, password, role) => User.create({ name, email, passwordHash: await User.hashPassword(password), role, isDemoData: true });
  await mk('Test Broker', 'broker.demo@ricoz.local', 'Broker123!', 'broker');
  await mk('Test Compliance', 'compliance.demo@ricoz.local', 'Compliance123!', 'compliance_officer');
  await mk('Test Admin', 'admin.demo@ricoz.local', 'Admin123!', 'admin');
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = 'http://localhost:' + server.address().port; resolve(); }); });
  brokerToken = await login('broker.demo@ricoz.local', 'Broker123!');
  complianceToken = await login('compliance.demo@ricoz.local', 'Compliance123!');
  adminToken = await login('admin.demo@ricoz.local', 'Admin123!');
});

after(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); }
  assertTestDatabase();
  await Carrier.deleteMany({ isDemoData: true });
  await Load.deleteMany({ isDemoData: true });
  await User.deleteMany({ isDemoData: true });
  await CarrierAssignment.deleteMany({ isDemoData: true });
  // Drop the whole PID-scoped database so no test database is left behind.
  // The connection is closed first: Mongoose's background model init would
  // otherwise re-create the collections right after the drop.
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

describe('Carrier Assignment Workflow (remediated)', () => {
  it('1. assigns a PASS carrier; identity stamped from JWT, snapshot complete', async () => {
    const load = await createReeferLoad('PASS');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() }, brokerToken);
    assert.equal(res.status, 200);
    assert.equal(data.assignment.assignmentDecision, 'APPROVED');
    assert.equal(data.assignment.ruleVersion, '1.0.0');
    assert.equal(data.assignment.assignedBy, 'broker.demo@ricoz.local');
    assert.equal(data.assignment.actorRole, 'broker');
    const snap = await CarrierAssignment.findById(data.assignment.id);
    assert.ok(snap);
    assert.equal(snap.attemptNumber, 1);
    assert.equal(snap.ruleVersion, '1.0.0');
    assert.ok(snap.evaluatedChecks.length > 0);
    snap.evaluatedChecks.forEach((c) => { assert.ok(c.ruleKey); assert.ok(c.evidenceSource); assert.ok(c.evidenceTimestamp); });
    const fresh = await Load.findById(load._id);
    assert.equal(fresh.status, 'ASSIGNED');
    assert.equal(String(fresh.auditSnapshotId), String(snap._id));
  });
  it('2. rejects FAIL carrier (cargo deficit); load stays POSTED, REJECTED snapshot kept', async () => {
    const load = await createReeferLoad('FAIL');
    const carrier = await Carrier.findOne({ dotNumber: '3109281' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() }, brokerToken);
    assert.equal(res.status, 400);
    assert.equal(data.overallStatus, 'FAIL');
    const snap = await CarrierAssignment.findById(data.auditSnapshotId);
    assert.equal(snap.assignmentDecision, 'REJECTED');
    assert.equal((await Load.findById(load._id)).status, 'POSTED');
  });
  it('3. blocks UNKNOWN (missing evidence) without override', async () => {
    const load = await createReeferLoad('UNKNOWN');
    const carrier = await Carrier.findOne({ dotNumber: '4019281' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() }, brokerToken);
    assert.equal(res.status, 400);
    assert.equal(data.overallStatus, 'UNKNOWN');
    assert.equal((await Load.findById(load._id)).status, 'POSTED');
  });
  it('4. blocks stale/expired evidence without override', async () => {
    const load = await createReeferLoad('STALE');
    const carrier = await Carrier.findOne({ dotNumber: '2701928' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() }, brokerToken);
    assert.equal(res.status, 400);
    assert.ok(['FAIL', 'NEEDS_REVIEW', 'UNKNOWN'].indexOf(data.overallStatus) !== -1);
    assert.equal((await Load.findById(load._id)).status, 'POSTED');
  });
  it('5. blocks conflicting evidence without override', async () => {
    const load = await createReeferLoad('CONFLICT');
    const carrier = await Carrier.findOne({ dotNumber: '3219401' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() }, brokerToken);
    assert.equal(res.status, 400);
    assert.equal(data.overallStatus, 'NEEDS_REVIEW');
    assert.ok((data.failedChecks || []).some((c) => c.ruleKey === 'EVIDENCE_CONSISTENCY'));
  });
  it('6. C1: forged compliance role in body is ignored; broker override still 403 + unauthenticated 401', async () => {
    const load = await createReeferLoad('FORGE');
    const carrier = await Carrier.findOne({ dotNumber: '3109281' });
    const forged = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString(), actorRole: 'compliance_officer', role: 'admin', authorizedBy: 'attacker@evil.local', overrideReason: 'Forged override attempt (Demo test)', allowOverride: true }, brokerToken);
    assert.equal(forged.res.status, 403);
    assert.equal(forged.data.code, 'UNAUTHORIZED_OVERRIDE');
    assert.equal((await Load.findById(load._id)).status, 'POSTED');
    const anon = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString() });
    assert.equal(anon.res.status, 401);
    assert.equal(anon.data.code, 'AUTH_REQUIRED');
  });
  it('7. compliance override succeeds; authorizer stamped from JWT, spoofed body identity ignored', async () => {
    const load = await createReeferLoad('OVERRIDE');
    const carrier = await Carrier.findOne({ dotNumber: '3109281' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString(), overrideReason: 'Shipper accepted gap coverage in writing (Demo)', authorizedBy: 'attacker@evil.local', allowOverride: true }, complianceToken);
    assert.equal(res.status, 200);
    assert.equal(data.assignment.assignmentDecision, 'OVERRIDDEN');
    assert.equal(data.assignment.overrideDetails.authorizedBy, 'compliance.demo@ricoz.local');
    assert.equal(data.assignment.overrideDetails.authorizedRole, 'compliance_officer');
    assert.ok(data.assignment.overrideDetails.authorizedAt);
    assert.equal((await Load.findById(load._id)).status, 'ASSIGNED');
  });
  it('8. short/missing override reason rejected; override on PASS rejected', async () => {
    const load = await createReeferLoad('NOREASON');
    const carrier = await Carrier.findOne({ dotNumber: '3109281' });
    const short = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: carrier._id.toString(), overrideReason: 'short' }, complianceToken);
    assert.ok([400].indexOf(short.res.status) !== -1);
    const passLoad = await createReeferLoad('PASSOVR');
    const apex = await Carrier.findOne({ dotNumber: '2849102' });
    const needless = await reqJSON('POST', baseUrl + '/api/loads/' + passLoad._id + '/assign', { carrierId: apex._id.toString(), overrideReason: 'Needless override attempt here (Demo)' }, complianceToken);
    assert.equal(needless.res.status, 400);
    assert.equal(needless.data.code, 'OVERRIDE_NOT_APPLICABLE');
  });
  it('9. C2: parallel assigns yield exactly one 200 + one 409 and a single approval snapshot', async () => {
    const load = await createReeferLoad('RACE');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const payload = { carrierId: carrier._id.toString() };
    const mk = () => reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', payload, brokerToken);
    const [a, b] = await Promise.all([mk(), mk()]);
    const statuses = [a.res.status, b.res.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const approvals = await CarrierAssignment.countDocuments({ loadId: load._id, assignmentDecision: { $in: ['APPROVED', 'OVERRIDDEN'] } });
    assert.equal(approvals, 1);
    const fresh = await Load.findById(load._id);
    assert.equal(fresh.status, 'ASSIGNED');
    assert.ok(fresh.auditSnapshotId);
  });
  it('10. H2: assignment getter returns ACTIVE approval, counts REJECTED attempts', async () => {
    const load = await createReeferLoad('HISTORY');
    const bad = await Carrier.findOne({ dotNumber: '3109281' });
    const r1 = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: bad._id.toString() }, brokerToken);
    assert.equal(r1.res.status, 400);
    const r2 = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: bad._id.toString(), overrideReason: 'Shipper accepted gap coverage in writing (Demo)' }, complianceToken);
    assert.equal(r2.res.status, 200);
    const g = await reqJSON('GET', baseUrl + '/api/loads/' + load._id + '/assignment', undefined, brokerToken);
    assert.equal(g.res.status, 200);
    assert.equal(g.data.snapshot.assignmentDecision, 'OVERRIDDEN');
    assert.equal(String(g.data.snapshot._id), String((await Load.findById(load._id)).auditSnapshotId));
    assert.ok(g.data.rejectedAttempts >= 1);
    const seq = await CarrierAssignment.find({ loadId: load._id }).sort({ attemptNumber: 1 });
    assert.deepEqual(seq.map((s) => s.assignmentDecision), ['REJECTED', 'OVERRIDDEN']);
  });
  it('11. H1: snapshot failure after claim releases load to POSTED (no orphan assignment)', async () => {
    const load = await createReeferLoad('SNAPFAIL');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const { evaluateCarrierForLoad } = require('../services/vettingEngine');
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, { actorRole: 'broker', authorizedBy: 'broker.demo@ricoz.local' });
    const FailingModel = { aggregate: () => Promise.resolve([]), countDocuments: () => Promise.resolve(0), create: () => Promise.reject(Object.assign(new Error('Simulated snapshot failure (Demo test)'), {})), findByIdAndDelete: () => Promise.resolve(null) };
    let thrown = null;
    try { await persistAssignmentConsistently({ load, carrier, evaluation, actor: { assignedBy: 'broker.demo@ricoz.local', actorRole: 'broker' }, decision, assignmentModel: FailingModel }); } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.match(thrown.message, /Simulated snapshot failure/);
    const fresh = await Load.findById(load._id);
    assert.equal(fresh.status, 'POSTED');
    assert.equal(fresh.auditSnapshotId || null, null);
  });
  it('12. M1: invalid ObjectIds rejected with INVALID_ID', async () => {
    const badLoad = await reqJSON('POST', baseUrl + '/api/loads/not-an-id/assign', { carrierId: 'also-bad' }, brokerToken);
    assert.equal(badLoad.res.status, 400);
    assert.equal(badLoad.data.code, 'INVALID_ID');
    const load = await createReeferLoad('BADID');
    const badCarrier = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', { carrierId: 'nope' }, brokerToken);
    assert.equal(badCarrier.res.status, 400);
    assert.equal(badCarrier.data.code, 'INVALID_ID');
    const g = await reqJSON('GET', baseUrl + '/api/loads/bogus/assignment', undefined, brokerToken);
    assert.equal(g.res.status, 400);
  });
  it('13. H3: load creation strips assignment-linkage + verify endpoint is compliance-only with JWT stamp', async () => {
    const apex = await Carrier.findOne({ dotNumber: '2849102' });
    const created = await reqJSON('POST', baseUrl + '/api/loads', { loadNumber: 'TEST-SPOOF-' + Date.now(), shipperName: 'S (Demo)', origin: { city: 'A', state: 'CA' }, destination: { city: 'B', state: 'IL' }, commodity: 'X (Demo)', equipmentType: 'DRY_VAN', declaredCargoValue: 5000, status: 'ASSIGNED', assignedCarrier: apex._id.toString(), auditSnapshotId: apex._id.toString() }, brokerToken);
    assert.equal(created.res.status, 201);
    assert.equal(created.data.load.status, 'POSTED');
    assert.equal(created.data.load.assignedCarrier || null, null);
    assert.equal(created.data.load.auditSnapshotId || null, null);
    const policyId = String(apex.insurancePolicies[0]._id);
    const denied = await reqJSON('PATCH', baseUrl + '/api/carriers/' + apex._id + '/policies/' + policyId + '/verify', { status: 'VERIFIED', verifiedBy: 'attacker@evil.local' }, brokerToken);
    assert.equal(denied.res.status, 403);
    const allowed = await reqJSON('PATCH', baseUrl + '/api/carriers/' + apex._id + '/policies/' + policyId + '/verify', { status: 'VERIFIED', verificationNotes: 'Called producer; endorsement confirmed (Demo test)', verifiedBy: 'attacker@evil.local' }, complianceToken);
    assert.equal(allowed.res.status, 200);
    assert.equal(allowed.data.policy.verifiedBy, 'compliance.demo@ricoz.local');
    // restore demo state
    await reqJSON('PATCH', baseUrl + '/api/carriers/' + apex._id + '/policies/' + policyId + '/verify', { status: 'VERIFIED', verificationNotes: 'restored' }, complianceToken);
  });
});
