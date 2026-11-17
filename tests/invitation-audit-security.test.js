const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AuditEvent = require('../models/AuditEvent');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_invitation_audit_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let owner, ownerToken, member, memberToken, outsider, outsiderToken, invitee, inviteeToken, otherInvitee, otherInviteeToken;
let companyA, companyB;

const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const json = (token, extra = {}) => auth(token, { 'Content-Type': 'application/json', ...extra });

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([
    Company.syncIndexes(), Membership.syncIndexes(), User.syncIndexes(),
    Invitation.syncIndexes(), AuditEvent.syncIndexes()
  ]);

  const passHash = await User.hashPassword('Password123!');
  owner = await User.create({ name: 'Owner', email: 'owner@example.com', passwordHash: passHash, role: 'broker' });
  member = await User.create({ name: 'Member', email: 'member@example.com', passwordHash: passHash, role: 'broker' });
  outsider = await User.create({ name: 'Outsider', email: 'outsider@example.com', passwordHash: passHash, role: 'broker' });
  invitee = await User.create({ name: 'Invitee', email: 'invitee@example.com', passwordHash: passHash, role: 'broker' });
  otherInvitee = await User.create({ name: 'Other', email: 'other@example.com', passwordHash: passHash, role: 'broker' });
  ownerToken = signToken(owner);
  memberToken = signToken(member);
  outsiderToken = signToken(outsider);
  inviteeToken = signToken(invitee);
  otherInviteeToken = signToken(otherInvitee);

  companyA = await Company.create({ name: 'Co A', slug: 'co-a-' + Date.now(), type: 'brokerage', owner: owner._id, createdBy: owner._id });
  companyB = await Company.create({ name: 'Co B', slug: 'co-b-' + Date.now(), type: 'brokerage', owner: outsider._id, createdBy: outsider._id });
  await Membership.create({ user: owner._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: member._id, company: companyA._id, role: 'broker', isActive: true });
  await Membership.create({ user: outsider._id, company: companyB._id, role: 'broker_owner', isActive: true });

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
});

beforeEach(async () => {
  await Invitation.collection.deleteMany({});
  await AuditEvent.collection.deleteMany({});
});

describe('Invitation and Audit Security', () => {
  it('requires manager context for invitation create/list/revoke and denies demo/non-member/mismatch', async () => {
    const payload = { email: 'invitee@example.com', role: 'broker' };

    const noAuth = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    assert.equal(noAuth.status, 401);

    const noCtx = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken), body: JSON.stringify(payload)
    });
    assert.equal(noCtx.status, 403);
    assert.equal((await noCtx.json()).code, 'COMPANY_CONTEXT_REQUIRED');

    const mismatch = await fetch(`${baseUrl}/api/companies/${companyB._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }), body: JSON.stringify(payload)
    });
    assert.equal(mismatch.status, 403);

    const notManager = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(memberToken, { 'X-Company-Id': String(companyA._id) }), body: JSON.stringify(payload)
    });
    assert.equal(notManager.status, 403);
    assert.equal((await notManager.json()).code, 'FORBIDDEN_COMPANY_ROLE');

    const demo = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id), 'X-Demo-Mode': 'true' }), body: JSON.stringify(payload)
    });
    assert.equal(demo.status, 403);
    assert.equal((await demo.json()).code, 'DEMO_NOT_ALLOWED');

    const outsider = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      headers: auth(outsiderToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(outsider.status, 403);
    assert.equal((await outsider.json()).code, 'NOT_A_MEMBER');
  });

  it('creates invitation with one-time token, revokes prior pending duplicates, and never exposes token/hash in list', async () => {
    const res1 = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST',
      headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'broker', expiresInDays: 3 })
    });
    assert.equal(res1.status, 201);
    const b1 = await res1.json();
    assert.equal(b1.success, true);
    assert.ok(typeof b1.token === 'string' && b1.token.length > 20);
    assert.equal(b1.invitation.email, 'invitee@example.com');
    assert.equal(b1.invitation.role, 'broker');
    assert.equal(b1.invitation.status, 'pending');
    assert.ok(!('tokenHash' in b1.invitation));

    const res2 = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST',
      headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'operations_manager' })
    });
    assert.equal(res2.status, 201);
    const b2 = await res2.json();
    assert.notEqual(b2.token, b1.token);

    const listRes = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations?include=all`, {
      headers: auth(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()).invitations;
    assert.ok(list.length >= 2);
    assert.ok(list.every((i) => !('token' in i) && !('tokenHash' in i)));
    const pending = list.filter((i) => i.email === 'invitee@example.com' && i.status === 'pending');
    const revoked = list.filter((i) => i.email === 'invitee@example.com' && i.status === 'revoked');
    assert.equal(pending.length, 1);
    assert.ok(revoked.length >= 1);
    assert.equal(pending[0].role, 'operations_manager');

    // token stored only as hash and not returned by default
    const storedDefault = await Invitation.find({ company: companyA._id, email: 'invitee@example.com' }).lean();
    assert.ok(storedDefault.length >= 2);
    assert.ok(storedDefault.every((i) => !('tokenHash' in i)));
    const stored = await Invitation.find({ company: companyA._id, email: 'invitee@example.com' }).select('+tokenHash').lean();
    assert.ok(stored.every((i) => typeof i.tokenHash === 'string' && i.tokenHash.length === 64));
    assert.ok(stored.every((i) => i.tokenHash !== b1.token && i.tokenHash !== b2.token));
  });

  it('validates role by company type and rejects invalid email/role', async () => {
    const badEmail = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'nope', role: 'broker' })
    });
    assert.equal(badEmail.status, 400);
    assert.equal((await badEmail.json()).code, 'INVALID_EMAIL');

    const badRole = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'carrier_owner' })
    });
    assert.equal(badRole.status, 400);
    assert.equal((await badRole.json()).code, 'INVALID_ROLE');
  });

  it('revokes pending invitations, blocks non-pending revoke, and records audit events', async () => {
    const create = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'broker' })
    });
    const inv = (await create.json()).invitation;

    const noCtx = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations/${inv.id}/revoke`, {
      method: 'POST', headers: json(ownerToken)
    });
    assert.equal(noCtx.status, 403);

    const revoke = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations/${inv.id}/revoke`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(revoke.status, 200);
    const rb = await revoke.json();
    assert.equal(rb.invitation.status, 'revoked');
    assert.ok(rb.invitation.revokedAt);

    const again = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations/${inv.id}/revoke`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'INVITATION_NOT_PENDING');

    const audits = await AuditEvent.find({ company: companyA._id }).lean();
    const actions = audits.map((a) => a.action);
    assert.ok(actions.includes('INVITATION_CREATED'));
    assert.ok(actions.includes('INVITATION_REVOKED'));
  });

  it('accepts invitation for matching user, enforces auth/email/demo/expiry/invalid token, and activates membership', async () => {
    const create = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'broker' })
    });
    const { token, invitation } = await create.json();

    const noAuth = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
    });
    assert.equal(noAuth.status, 401);

    const demo = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(inviteeToken, { 'X-Demo-Mode': 'true' }), body: JSON.stringify({ token })
    });
    assert.equal(demo.status, 403);

    const wrongEmail = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(otherInviteeToken), body: JSON.stringify({ token })
    });
    assert.equal(wrongEmail.status, 403);
    assert.equal((await wrongEmail.json()).code, 'INVITATION_EMAIL_MISMATCH');

    const badToken = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(inviteeToken), body: JSON.stringify({ token: 'not-a-real-token' })
    });
    assert.equal(badToken.status, 404);

    const accept = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(inviteeToken), body: JSON.stringify({ token })
    });
    assert.equal(accept.status, 200);
    const ab = await accept.json();
    assert.equal(ab.success, true);
    assert.equal(String(ab.company.id), String(companyA._id));
    assert.equal(ab.membership.role, 'broker');
    assert.equal(String(ab.membership.userId), String(invitee._id));

    const m = await Membership.findOne({ user: invitee._id, company: companyA._id, isActive: true });
    assert.ok(m);
    assert.equal(m.role, 'broker');

    const used = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(inviteeToken), body: JSON.stringify({ token })
    });
    assert.equal(used.status, 409);

    // expiry enforcement
    const create2 = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'other@example.com', role: 'viewer', expiresInDays: 1 })
    });
    const b2 = await create2.json();
    await Invitation.updateOne({ _id: b2.invitation.id }, { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } });
    const expired = await fetch(`${baseUrl}/api/companies/invitations/accept`, {
      method: 'POST', headers: json(otherInviteeToken), body: JSON.stringify({ token: b2.token })
    });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, 'INVITATION_EXPIRED');

    const audits = await AuditEvent.find({ company: companyA._id }).lean();
    assert.ok(audits.some((a) => a.action === 'INVITATION_ACCEPTED'));

    // list shows persisted expiry state
    const listRes = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations?include=all`, {
      headers: auth(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    const listed = (await listRes.json()).invitations;
    const expiredListed = listed.find((i) => String(i.id) === String(b2.invitation.id));
    assert.ok(expiredListed);
    assert.equal(expiredListed.status, 'expired');

    // ensure original invitation marked accepted
    const storedInv = await Invitation.findById(invitation.id).lean();
    assert.equal(storedInv.status, 'accepted');
  });

  it('audit-events endpoint is manager-only, tenant-scoped, and includes company/member/invite actions without leaking tokens', async () => {
    // generate some auditable actions
    await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'invitee@example.com', role: 'broker' })
    });
    await fetch(`${baseUrl}/api/companies/${companyA._id}/members`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ userId: String(otherInvitee._id), role: 'broker' })
    });

    const noCtx = await fetch(`${baseUrl}/api/companies/${companyA._id}/audit-events`, {
      headers: auth(ownerToken)
    });
    assert.equal(noCtx.status, 403);

    const forbidden = await fetch(`${baseUrl}/api/companies/${companyA._id}/audit-events`, {
      headers: auth(memberToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(forbidden.status, 403);

    const cross = await fetch(`${baseUrl}/api/companies/${companyB._id}/audit-events`, {
      headers: auth(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(cross.status, 403);

    const ok = await fetch(`${baseUrl}/api/companies/${companyA._id}/audit-events`, {
      headers: auth(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.events));
    const actions = body.events.map((e) => e.action);
    assert.ok(actions.includes('INVITATION_CREATED'));
    assert.ok(actions.includes('MEMBERSHIP_CREATED'));
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('tokenHash'));
    // ensure other company's events not visible (create in companyB)
    await fetch(`${baseUrl}/api/companies/${companyB._id}/invitations`, {
      method: 'POST', headers: json(outsiderToken, { 'X-Company-Id': String(companyB._id) }),
      body: JSON.stringify({ email: 'z@example.com', role: 'broker' })
    });
    const ok2 = await fetch(`${baseUrl}/api/companies/${companyA._id}/audit-events`, {
      headers: auth(ownerToken, { 'X-Company-Id': String(companyA._id) })
    });
    const b2 = await ok2.json();
    assert.ok(!b2.events.some((e) => e.metadata && e.metadata.email === 'z@example.com'));
  });

  it('audit events are tenant-isolated in storage, append-only, and exclude secrets/sensitive tokens', async () => {
    await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
      method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
      body: JSON.stringify({ email: 'secret-check@example.com', role: 'broker' })
    });
    const aEvents = await AuditEvent.find({ company: companyA._id }).lean();
    assert.ok(aEvents.length > 0);
    assert.ok(aEvents.every((e) => String(e.company) === String(companyA._id)));
    const aSerialized = JSON.stringify(aEvents);
    assert.ok(!aSerialized.includes('tokenHash'));
    assert.ok(!aSerialized.includes('password'));

    await fetch(`${baseUrl}/api/companies/${companyB._id}/invitations`, {
      method: 'POST', headers: json(outsiderToken, { 'X-Company-Id': String(companyB._id) }),
      body: JSON.stringify({ email: 'b-only@example.com', role: 'broker' })
    });
    const bEvents = await AuditEvent.find({ company: companyB._id }).lean();
    assert.ok(bEvents.every((e) => String(e.company) === String(companyB._id)));
    assert.ok(!JSON.stringify(aEvents).includes('b-only@example.com'));

    const evt = await AuditEvent.findOne({ company: companyA._id });
    await assert.rejects(() => AuditEvent.updateOne({ _id: evt._id }, { $set: { action: 'TAMPERED' } }));
    await assert.rejects(() => AuditEvent.deleteOne({ _id: evt._id }));
    await assert.rejects(async () => {
      evt.action = 'TAMPERED';
      await evt.save();
    });
    const still = await AuditEvent.findById(evt._id).lean();
    assert.notEqual(still.action, 'TAMPERED');
  });

  it('audit logging failures do not break primary invitation flow', async () => {
    const originalCreate = AuditEvent.create;
    AuditEvent.create = async () => { throw new Error('audit store unavailable'); };
    try {
      const res = await fetch(`${baseUrl}/api/companies/${companyA._id}/invitations`, {
        method: 'POST', headers: json(ownerToken, { 'X-Company-Id': String(companyA._id) }),
        body: JSON.stringify({ email: 'resilient@example.com', role: 'broker' })
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(body.token);
      assert.equal(body.invitation.email, 'resilient@example.com');
    } finally {
      AuditEvent.create = originalCreate;
    }
  });
});
