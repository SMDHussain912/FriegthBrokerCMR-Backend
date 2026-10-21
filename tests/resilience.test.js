/**
 * Resilience & security-regression tests.
 *
 * Covers the paths that the happy-path assignment suite does not reach:
 *  - JWT fail-closed behaviour in production (missing / demo / short secret)
 *  - token tampering, expiry, deleted-user and role-gate handling
 *  - demo-account lockout in production
 *  - unique approval index initialization + legacy duplicate demotion
 *  - crash recovery of loads left ASSIGNED without an active snapshot
 *  - rollback of the claim when the snapshot link fails
 *
 * DEMO data only. Uses its own PID-scoped MongoDB database.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../app');
const Carrier = require('../models/Carrier');
const Load = require('../models/Load');
const User = require('../models/User');
const CarrierAssignment = require('../models/CarrierAssignment');
const { DEMO_CARRIERS, DEMO_LOADS } = require('../services/mockData/fmcsaDemoData');
const { ensureAssignmentIndexes, UNIQUE_INDEX_NAME } = require('../services/assignmentIndexInitializer');
const { reconcileOrphanedAssignments } = require('../services/assignmentRecovery');
const { persistAssignmentConsistently, decideAssignment } = require('../services/assignmentService');
const { evaluateCarrierForLoad } = require('../services/vettingEngine');
const { dropTestDatabase } = require('./helpers/testDb');

// PID-scoped DB: two test processes can never share state.
const TEST_DB_URI = process.env.RESILIENCE_TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_resilience_test_' + process.pid;

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
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { res, data };
};

const createReeferLoad = async (tag, overrides = {}) => {
  suffix += 1;
  return Load.create(Object.assign({
    loadNumber: 'RES-' + tag + '-' + Date.now() + '-' + suffix + '-' + Math.floor(Math.random() * 100000),
    shipperName: 'Test Shipper (Demo)',
    origin: { city: 'Salinas', state: 'CA' },
    destination: { city: 'Chicago', state: 'IL' },
    commodity: 'Fresh Organic Strawberries (Demo)',
    equipmentType: 'REEFER',
    targetTemperature: 34,
    declaredCargoValue: 200000,
    loadRequirements: {
      minAuthorityAgeDays: 90,
      minAutoLiability: 1000000,
      requireReeferEndorsement: true,
      disallowConditionalSafety: true,
      maxUnsafeDrivingPercentile: 75
    },
    status: 'POSTED',
    isDemoData: true
  }, overrides));
};

const login = async (email, password) => {
  const { res, data } = await reqJSON('POST', baseUrl + '/api/auth/login', { email, password });
  assert.equal(res.status, 200, 'login must succeed for ' + email);
  assert.ok(data.token, 'login returns JWT');
  return data.token;
};

// Temporarily override env vars for the duration of `fn`, then restore.
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) { delete process.env[key]; } else { process.env[key] = vars[key]; }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = saved[key]; }
    }
  }
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
  const mk = async (name, email, password, role) => User.create({
    name, email, passwordHash: await User.hashPassword(password), role, isDemoData: true
  });
  await mk('Test Broker', 'broker.res@ricoz.local', 'Broker123!', 'broker');
  await mk('Test Compliance', 'compliance.res@ricoz.local', 'Compliance123!', 'compliance_officer');
  await mk('Test Admin', 'admin.res@ricoz.local', 'Admin123!', 'admin');
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = 'http://localhost:' + server.address().port;
      resolve();
    });
  });
  brokerToken = await login('broker.res@ricoz.local', 'Broker123!');
  complianceToken = await login('compliance.res@ricoz.local', 'Compliance123!');
  adminToken = await login('admin.res@ricoz.local', 'Admin123!');
});

after(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); }
  assertTestDatabase();
  // The connection is closed first: Mongoose's background model init would
  // otherwise re-create the collections right after the drop.
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});


describe('JWT fail-closed behaviour', () => {
  it('rejects a token signed with the wrong secret (401 INVALID_TOKEN)', async () => {
    const admin = await User.findOne({ email: 'admin.res@ricoz.local' });
    const forged = jwt.sign(
      { sub: String(admin._id), email: admin.email, role: 'admin' },
      'attacker_signing_key_that_is_not_the_real_one_1234',
      { expiresIn: '12h' }
    );
    const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, forged);
    assert.equal(res.status, 401);
    assert.equal(data.code, 'INVALID_TOKEN');
  });

  it('rejects a token whose payload was tampered with (401 INVALID_TOKEN)', async () => {
    const parts = brokerToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.role = 'admin';
    const tampered = parts[0] + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + parts[2];
    const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, tampered);
    assert.equal(res.status, 401);
    assert.equal(data.code, 'INVALID_TOKEN');
  });

  it('rejects an expired token (401 INVALID_TOKEN)', async () => {
    const user = await User.findOne({ email: 'broker.res@ricoz.local' });
    const expired = jwt.sign(
      { sub: String(user._id), email: user.email, role: 'broker' },
      process.env.JWT_SECRET || 'development_jwt_secret_freight_broker_crm_2026',
      { expiresIn: '-1s' }
    );
    const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, expired);
    assert.equal(res.status, 401);
    assert.equal(data.code, 'INVALID_TOKEN');
  });

  it('rejects a token for a user that no longer exists (401 USER_NOT_FOUND)', async () => {
    const user = await User.findOne({ email: 'broker.res@ricoz.local' });
    const token = jwt.sign(
      { sub: String(user._id), email: user.email, role: 'broker' },
      process.env.JWT_SECRET || 'development_jwt_secret_freight_broker_crm_2026',
      { expiresIn: '12h' }
    );
    await User.deleteOne({ _id: user._id });
    const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, token);
    assert.equal(res.status, 401);
    assert.equal(data.code, 'USER_NOT_FOUND');
    // restore the user for the remaining tests (new _id -> re-issue the token)
    await User.create({
      name: 'Test Broker',
      email: 'broker.res@ricoz.local',
      passwordHash: await User.hashPassword('Broker123!'),
      role: 'broker',
      isDemoData: true
    });
    brokerToken = await login('broker.res@ricoz.local', 'Broker123!');
  });


  it('rejects a malformed Authorization header (401 AUTH_REQUIRED)', async () => {
    const noHeader = await reqJSON('GET', baseUrl + '/api/auth/me');
    assert.equal(noHeader.res.status, 401);
    assert.equal(noHeader.data.code, 'AUTH_REQUIRED');
    const basic = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, 'Basic abc');
    assert.equal(basic.res.status, 401);
    assert.equal(basic.data.code, 'AUTH_REQUIRED');
  });
});

describe('Production configuration guards', () => {
  it('refuses to authenticate when the production secret is missing (500, not a silent fallback)', async () => {
    await withEnv({ NODE_ENV: 'production', JWT_SECRET: undefined }, async () => {
      const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, brokerToken);
      assert.equal(res.status, 500);
      assert.equal(data.success, false);
      assert.match(data.error, /JWT_SECRET must be set in production/);
    });
  });

  it('refuses to authenticate when production uses the published demo secret (500)', async () => {
    await withEnv(
      { NODE_ENV: 'production', JWT_SECRET: 'development_jwt_secret_freight_broker_crm_2026' },
      async () => {
        const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, brokerToken);
        assert.equal(res.status, 500);
        assert.match(data.error, /demo JWT_SECRET must not be used in production/);
      }
    );
  });

  it('refuses to authenticate when the production secret is too short (500)', async () => {
    await withEnv({ NODE_ENV: 'production', JWT_SECRET: 'tooshort' }, async () => {
      const { res, data } = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, brokerToken);
      assert.equal(res.status, 500);
      assert.match(data.error, /at least 32 characters/);
    });
  });

  it('blocks demo accounts from logging in when NODE_ENV=production (403)', async () => {
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const { res, data } = await reqJSON('POST', baseUrl + '/api/auth/login', {
        email: 'broker.res@ricoz.local',
        password: 'Broker123!'
      });
      assert.equal(res.status, 403);
      assert.equal(data.code, 'DEMO_ACCOUNT_DISABLED');
    });
  });

  it('rejects bad credentials without leaking which field was wrong (401)', async () => {
    const wrongPassword = await reqJSON('POST', baseUrl + '/api/auth/login', {
      email: 'broker.res@ricoz.local', password: 'WrongPassword123!'
    });
    assert.equal(wrongPassword.res.status, 401);
    assert.equal(wrongPassword.data.error, 'Invalid email or password');
    const unknownUser = await reqJSON('POST', baseUrl + '/api/auth/login', {
      email: 'nobody@ricoz.local', password: 'Broker123!'
    });
    assert.equal(unknownUser.res.status, 401);
    assert.equal(unknownUser.data.error, 'Invalid email or password');
    const missing = await reqJSON('POST', baseUrl + '/api/auth/login', { email: 'broker.res@ricoz.local' });
    assert.equal(missing.res.status, 400);
    assert.equal(missing.data.code, 'CREDENTIALS_REQUIRED');
  });

  it('never returns the password hash in API responses', async () => {
    const { res, data } = await reqJSON('POST', baseUrl + '/api/auth/login', {
      email: 'broker.res@ricoz.local', password: 'Broker123!'
    });
    assert.equal(res.status, 200);
    assert.equal(data.user.passwordHash, undefined);
    assert.equal(data.user.password, undefined);
    assert.equal(data.user.role, 'broker');
    const me = await reqJSON('GET', baseUrl + '/api/auth/me', undefined, brokerToken);
    assert.equal(me.data.user.passwordHash, undefined);
  });
});

describe('Unique approval index initialization', () => {
  it('creates the unique partial approval index and is idempotent', async () => {
    const first = await ensureAssignmentIndexes({ logger: { log: () => {}, warn: () => {} } });
    assert.ok(Array.isArray(first.indexes));
    const guard = first.indexes.find((i) => i.name === UNIQUE_INDEX_NAME);
    assert.ok(guard, 'unique approval index must exist');
    assert.equal(guard.unique, true);
    // running it again must not throw (idempotent)
    const second = await ensureAssignmentIndexes({ logger: { log: () => {}, warn: () => {} } });
    const guard2 = second.indexes.find((i) => i.name === UNIQUE_INDEX_NAME);
    assert.ok(guard2);
    assert.equal(guard2.unique, true);
  });

  it('enforces one approval per load at the database level', async () => {
    const load = await createReeferLoad('IDX');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const mk = (decision) => ({
      loadId: load._id,
      loadNumber: load.loadNumber,
      carrierId: carrier._id,
      carrierName: carrier.legalName,
      assignedBy: 'index.test@ricoz.local',
      actorRole: 'broker',
      attemptNumber: 1,
      ruleVersion: '1.0.0',
      overallStatus: 'PASS',
      assignmentDecision: decision,
      evaluatedChecks: [{
        ruleKey: 'X', ruleName: 'X', status: 'PASS',
        evidenceSource: 'Mock FMCSA SAFER Provider (Demo)', evidenceTimestamp: new Date()
      }],
      isDemoData: true
    });
    await CarrierAssignment.create(mk('APPROVED'));
    // a second approval for the same load must violate the unique index
    let dupError = null;
    try { await CarrierAssignment.create(mk('APPROVED')); } catch (e) { dupError = e; }
    assert.ok(dupError, 'duplicate approval must be rejected');
    assert.equal(dupError.code, 11000);
    // a REJECTED audit row for the same load is still allowed
    const rejected = await CarrierAssignment.create(mk('REJECTED'));
    assert.ok(rejected._id);
  });

  it('demotes legacy duplicate approvals to SUPERSEDED instead of deleting them', async () => {
    const load = await createReeferLoad('DUP');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const base = {
      loadId: load._id,
      loadNumber: load.loadNumber,
      carrierId: carrier._id,
      carrierName: carrier.legalName,
      assignedBy: 'legacy@ricoz.local',
      actorRole: 'broker',
      attemptNumber: 1,
      ruleVersion: '1.0.0',
      overallStatus: 'PASS',
      evaluatedChecks: [{
        ruleKey: 'X', ruleName: 'X', status: 'PASS',
        evidenceSource: 'Mock FMCSA SAFER Provider (Demo)', evidenceTimestamp: new Date()
      }],
      isDemoData: true
    };
    // Simulate legacy data: two approvals for one load in a DB that has no
    // unique index yet (the state that used to break index creation).
    await CarrierAssignment.collection.dropIndex(UNIQUE_INDEX_NAME);
    await CarrierAssignment.collection.insertMany([
      Object.assign({}, base, { assignmentDecision: 'APPROVED' }),
      Object.assign({}, base, { assignmentDecision: 'APPROVED' })
    ]);
    const before = await CarrierAssignment.countDocuments({ loadId: load._id });
    assert.equal(before, 2);

    const result = await ensureAssignmentIndexes({ logger: { log: () => {}, warn: () => {} } });
    assert.equal(result.repair.loadsScanned, 1);

    const after = await CarrierAssignment.find({ loadId: load._id }).sort({ createdAt: 1 });
    assert.equal(after.length, 2, 'audit trail must be preserved, nothing deleted');
    const decisions = after.map((s) => s.assignmentDecision).sort();
    assert.deepEqual(decisions, ['APPROVED', 'SUPERSEDED']);
    const demoted = after.find((s) => s.assignmentDecision === 'SUPERSEDED');
    assert.ok(demoted.supersededAt);
    assert.match(demoted.supersededReason, /duplicate approval demoted/i);
  });
});

describe('Crash recovery of orphaned assignments', () => {
  const silentLogger = { log: () => {}, warn: () => {} };

  it('releases a load left ASSIGNED with no approval snapshot back to POSTED', async () => {
    const load = await createReeferLoad('ORPHAN');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    // Simulate a crash between the atomic claim and the snapshot creation.
    await Load.findByIdAndUpdate(load._id, {
      $set: {
        status: 'ASSIGNED',
        assignedCarrier: carrier._id,
        assignedAt: new Date(),
        assignedBy: 'broker.res@ricoz.local'
      }
    });
    const before = await Load.findById(load._id);
    assert.equal(before.status, 'ASSIGNED');
    assert.equal(before.auditSnapshotId || null, null);

    const result = await reconcileOrphanedAssignments({ logger: silentLogger });
    assert.equal(result.released, 1);
    assert.equal(result.repaired, 0);

    const after = await Load.findById(load._id);
    assert.equal(after.status, 'POSTED', 'orphaned claim must be released');
    assert.equal(after.assignedCarrier || null, null);
    assert.equal(after.assignedAt || null, null);
    assert.equal(after.assignedBy || null, null);
    assert.equal(after.auditSnapshotId || null, null);
  });

  it('re-links the surviving approval snapshot when only the link was lost', async () => {
    const load = await createReeferLoad('RELINK');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, {
      actorRole: 'broker', authorizedBy: 'broker.res@ricoz.local'
    });
    const persisted = await persistAssignmentConsistently({
      load, carrier, evaluation,
      actor: { assignedBy: 'broker.res@ricoz.local', actorRole: 'broker' },
      decision
    });
    // Simulate a crash after the snapshot was written but before it was linked.
    await Load.findByIdAndUpdate(load._id, { $unset: { auditSnapshotId: '' } });
    const broken = await Load.findById(load._id);
    assert.equal(broken.status, 'ASSIGNED');
    assert.equal(broken.auditSnapshotId || null, null);

    const result = await reconcileOrphanedAssignments({ logger: silentLogger });
    assert.equal(result.repaired, 1);
    assert.equal(result.released, 0);

    const after = await Load.findById(load._id);
    assert.equal(after.status, 'ASSIGNED', 'a load with a valid snapshot must stay assigned');
    assert.equal(String(after.auditSnapshotId), String(persisted.snapshot._id));
  });

  it('releases a load whose only snapshot was a REJECTED audit row', async () => {
    const load = await createReeferLoad('REJONLY');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    await CarrierAssignment.create({
      loadId: load._id,
      loadNumber: load.loadNumber,
      carrierId: carrier._id,
      carrierName: carrier.legalName,
      assignedBy: 'broker.res@ricoz.local',
      actorRole: 'broker',
      attemptNumber: 1,
      ruleVersion: '1.0.0',
      overallStatus: 'FAIL',
      assignmentDecision: 'REJECTED',
      evaluatedChecks: [{
        ruleKey: 'X', ruleName: 'X', status: 'FAIL',
        evidenceSource: 'Mock FMCSA SAFER Provider (Demo)', evidenceTimestamp: new Date()
      }],
      isDemoData: true
    });
    await Load.findByIdAndUpdate(load._id, {
      $set: {
        status: 'ASSIGNED',
        assignedCarrier: carrier._id,
        assignedAt: new Date(),
        assignedBy: 'broker.res@ricoz.local'
      }
    });

    const result = await reconcileOrphanedAssignments({ logger: silentLogger });
    assert.equal(result.released, 1);
    const after = await Load.findById(load._id);
    assert.equal(after.status, 'POSTED');
  });

  it('leaves healthy loads untouched (no-op on a clean database)', async () => {
    const load = await createReeferLoad('HEALTHY');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, {
      actorRole: 'broker', authorizedBy: 'broker.res@ricoz.local'
    });
    const persisted = await persistAssignmentConsistently({
      load, carrier, evaluation,
      actor: { assignedBy: 'broker.res@ricoz.local', actorRole: 'broker' },
      decision
    });

    const result = await reconcileOrphanedAssignments({ logger: silentLogger });
    assert.equal(result.repaired, 0);
    assert.equal(result.released, 0);

    const after = await Load.findById(load._id);
    assert.equal(after.status, 'ASSIGNED');
    assert.equal(String(after.auditSnapshotId), String(persisted.snapshot._id));
  });
});

describe('Rollback of the claim when persistence fails', () => {
  it('releases the load and removes the snapshot when the link step fails', async () => {
    const load = await createReeferLoad('LINKFAIL');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, {
      actorRole: 'broker', authorizedBy: 'broker.res@ricoz.local'
    });

    // Load model whose link step always fails to match -> the service must
    // roll the claim back instead of leaving an ASSIGNED load without audit.
    const linkFailingLoadModel = Object.create(Load);
    const realFindOneAndUpdate = Load.findOneAndUpdate.bind(Load);
    let linkCalls = 0;
    linkFailingLoadModel.findOneAndUpdate = async (filter, update, options) => {
      const sets = (update && update.$set) || {};
      if (sets.auditSnapshotId) {
        linkCalls += 1;
        return null; // simulate the link update not matching
      }
      return realFindOneAndUpdate(filter, update, options);
    };

    let thrown = null;
    try {
      await persistAssignmentConsistently({
        load, carrier, evaluation,
        actor: { assignedBy: 'broker.res@ricoz.local', actorRole: 'broker' },
        decision,
        loadModel: linkFailingLoadModel
      });
    } catch (e) { thrown = e; }

    assert.ok(thrown, 'a failed link must surface as an error');
    assert.equal(thrown.code, 'SNAPSHOT_LINK_FAILED');
    assert.equal(linkCalls, 1);

    const after = await Load.findById(load._id);
    assert.equal(after.status, 'POSTED', 'the claim must be rolled back');
    assert.equal(after.assignedCarrier || null, null);
    assert.equal(after.auditSnapshotId || null, null);
    const snaps = await CarrierAssignment.find({ loadId: load._id });
    assert.equal(snaps.length, 0, 'the orphaned snapshot must be removed');
  });

  it('releases the load when the snapshot write fails after the claim', async () => {
    const load = await createReeferLoad('SNAPFAIL');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, {
      actorRole: 'broker', authorizedBy: 'broker.res@ricoz.local'
    });
    const FailingModel = {
      aggregate: () => Promise.resolve([]),
      countDocuments: () => Promise.resolve(0),
      create: () => Promise.reject(new Error('Simulated snapshot failure (Demo test)')),
      findByIdAndDelete: () => Promise.resolve(null)
    };
    let thrown = null;
    try {
      await persistAssignmentConsistently({
        load, carrier, evaluation,
        actor: { assignedBy: 'broker.res@ricoz.local', actorRole: 'broker' },
        decision,
        assignmentModel: FailingModel
      });
    } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.match(thrown.message, /Simulated snapshot failure/);
    const after = await Load.findById(load._id);
    assert.equal(after.status, 'POSTED');
    assert.equal(after.auditSnapshotId || null, null);
  });

  it('maps a duplicate approval to a 409 conflict instead of a 500', async () => {
    const load = await createReeferLoad('DUPKEY');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
    const decision = decideAssignment(evaluation, {
      actorRole: 'broker', authorizedBy: 'broker.res@ricoz.local'
    });
    const DupModel = {
      aggregate: () => Promise.resolve([]),
      countDocuments: () => Promise.resolve(0),
      create: () => Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })),
      findByIdAndDelete: () => Promise.resolve(null)
    };
    let thrown = null;
    try {
      await persistAssignmentConsistently({
        load, carrier, evaluation,
        actor: { assignedBy: 'broker.res@ricoz.local', actorRole: 'broker' },
        decision,
        assignmentModel: DupModel
      });
    } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.equal(thrown.code, 'ASSIGNMENT_CONFLICT');
    assert.equal(thrown.statusCode, 409);
    const after = await Load.findById(load._id);
    assert.equal(after.status, 'POSTED');
  });
});

describe('Concurrent assignment safety', () => {
  it('lets exactly one concurrent claim win and records a single approval', async () => {
    const load = await createReeferLoad('RACE');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const payload = { carrierId: carrier._id.toString() };

    const results = await Promise.all([
      reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', payload, brokerToken),
      reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', payload, brokerToken)
    ]);
    const statuses = results.map((r) => r.res.status).sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one winner, one conflict');

    const approvals = await CarrierAssignment.countDocuments({
      loadId: load._id, assignmentDecision: { $in: ['APPROVED', 'OVERRIDDEN'] }
    });
    assert.equal(approvals, 1, 'only one approval snapshot may exist');
    const fresh = await Load.findById(load._id);
    assert.equal(fresh.status, 'ASSIGNED');
    assert.ok(fresh.auditSnapshotId);
  });

  it('does not let a client spoof the approving identity or role', async () => {
    const load = await createReeferLoad('SPOOF');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', {
      carrierId: carrier._id.toString(),
      assignedBy: 'attacker@evil.local',
      actorRole: 'admin',
      role: 'admin',
      authorizedBy: 'attacker@evil.local',
      allowOverride: true
    }, brokerToken);
    assert.equal(res.status, 200);
    assert.equal(data.assignment.assignedBy, 'broker.res@ricoz.local');
    assert.equal(data.assignment.actorRole, 'broker');
    const snap = await CarrierAssignment.findById(data.assignment.id);
    assert.equal(snap.assignedBy, 'broker.res@ricoz.local');
    assert.equal(snap.actorRole, 'broker');
    assert.equal(snap.overrideDetails.overrideGranted, false);
  });

  it('rejects a needless override for an already-passing carrier (400 OVERRIDE_NOT_APPLICABLE)', async () => {
    const load = await createReeferLoad('NEEDLESS');
    const carrier = await Carrier.findOne({ dotNumber: '2849102' });
    const { res, data } = await reqJSON('POST', baseUrl + '/api/loads/' + load._id + '/assign', {
      carrierId: carrier._id.toString(),
      overrideReason: 'Needless override attempt here (Demo)',
      allowOverride: true
    }, complianceToken);
    assert.equal(res.status, 400);
    assert.equal(data.code, 'OVERRIDE_NOT_APPLICABLE');
    const fresh = await Load.findById(load._id);
    assert.equal(fresh.status, 'POSTED');
  });
});


