const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../app');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const Customer = require('../models/Customer');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Opportunity = require('../models/Opportunity');
const Quote = require('../models/Quote');
const RateAgreement = require('../models/RateAgreement');
const Stop = require('../models/Stop');
const LoadEvent = require('../models/LoadEvent');
const Tender = require('../models/Tender');
const AuditEvent = require('../models/AuditEvent');
const { signToken } = require('../middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_crm_tms_security_test_' + process.pid;

const assertTestDatabase = () => {
  const name = mongoose.connection.name || '';
  assert.ok(name.includes('test'), 'Refusing cleanup: not a test database (got ' + name + ')');
};

let server;
let baseUrl;
let owner;
let ownerToken;
let viewer;
let viewerToken;
let outsider;
let outsiderToken;
let companyA;
let companyB;

const jsonHeaders = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra });

const post = async (path, token, body, extra = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(token, extra), body: JSON.stringify(body || {}) });
  return { res, body: await res.json().catch(() => ({})) };
};

const patch = async (path, token, body, extra = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: jsonHeaders(token, extra), body: JSON.stringify(body || {}) });
  return { res, body: await res.json().catch(() => ({})) };
};

const put = async (path, token, body, extra = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PUT', headers: jsonHeaders(token, extra), body: JSON.stringify(body || {}) });
  return { res, body: await res.json().catch(() => ({})) };
};

const get = async (path, token, extra = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: jsonHeaders(token, extra) });
  return { res, body: await res.json().catch(() => ({})) };
};

const del = async (path, token, extra = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers: jsonHeaders(token, extra) });
  return { res, body: await res.json().catch(() => ({})) };
};

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  assertTestDatabase();
  await Promise.all([
    Company.syncIndexes(), Membership.syncIndexes(), User.syncIndexes(), Load.syncIndexes(),
    Carrier.syncIndexes(), Customer.syncIndexes(), Contact.syncIndexes(), Lead.syncIndexes(),
    Opportunity.syncIndexes(), Quote.syncIndexes(), RateAgreement.syncIndexes(), Stop.syncIndexes(),
    LoadEvent.syncIndexes(), Tender.syncIndexes(), AuditEvent.syncIndexes(),
  ]);

  const passHash = await User.hashPassword('Password123!');
  owner = await User.create({ name: 'Owner', email: 'crm-owner@example.com', passwordHash: passHash, role: 'broker' });
  viewer = await User.create({ name: 'Viewer', email: 'crm-viewer@example.com', passwordHash: passHash, role: 'broker' });
  outsider = await User.create({ name: 'Outsider', email: 'crm-outsider@example.com', passwordHash: passHash, role: 'broker' });
  ownerToken = signToken(owner);
  viewerToken = signToken(viewer);
  outsiderToken = signToken(outsider);

  companyA = await Company.create({ name: 'CRM Co A', slug: 'crm-a-' + Date.now(), type: 'brokerage', owner: owner._id, createdBy: owner._id });
  companyB = await Company.create({ name: 'CRM Co B', slug: 'crm-b-' + Date.now(), type: 'brokerage', owner: outsider._id, createdBy: outsider._id });
  await Membership.create({ user: owner._id, company: companyA._id, role: 'broker_owner', isActive: true });
  await Membership.create({ user: viewer._id, company: companyA._id, role: 'viewer', isActive: true });
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

describe('CRM security and tenant isolation', () => {
  it('requires authentication and verified company context for every CRM collection', async () => {
    const anon = await get('/api/crm/customers');
    assert.equal(anon.res.status, 401);

    const noContext = await get('/api/crm/customers', ownerToken);
    assert.equal(noContext.res.status, 403);
    assert.equal(noContext.body.code, 'COMPANY_CONTEXT_REQUIRED');

    const outsiderContext = await get(`/api/crm/customers`, outsiderToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(outsiderContext.res.status, 403);
    assert.equal(outsiderContext.body.code, 'NOT_A_MEMBER');
  });

  it('enforces role permissions and rejects demo-mode company writes', async () => {
    const viewerCreate = await post('/api/crm/customers', viewerToken, { name: 'Blocked' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(viewerCreate.res.status, 403);
    assert.equal(viewerCreate.body.code, 'FORBIDDEN_ROLE');

    const demoCreate = await post('/api/crm/customers', ownerToken, { name: 'Demo Co' }, { 'X-Company-Id': String(companyA._id), 'X-Demo-Mode': 'true' });
    assert.equal(demoCreate.res.status, 403);
    assert.equal(demoCreate.body.code, 'DEMO_NOT_ALLOWED');

    const badBody = await post('/api/crm/customers', ownerToken, { name: '   ' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(badBody.res.status, 400);
    assert.equal(badBody.body.code, 'REQUIRED_FIELD');

    const protectedField = await post('/api/crm/customers', ownerToken, { name: 'Hack', company: String(companyB._id) }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(protectedField.res.status, 400);
    assert.equal(protectedField.body.code, 'INVALID_FIELDS');
  });

  it('keeps customers, contacts, leads, opportunities, quotes and rate agreements tenant-scoped', async () => {
    const customer = await post('/api/crm/customers', ownerToken, { name: 'Shipper One', type: 'shipper', email: 'ops@shipper1.example' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(customer.res.status, 201);
    const customerId = customer.body.customer._id;
    assert.equal(String(customer.body.customer.company), String(companyA._id));

    const contact = await post('/api/crm/contacts', ownerToken, { customer: customerId, name: 'Dana Ops', email: 'dana@shipper1.example' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(contact.res.status, 201);

    const lead = await post('/api/crm/leads', ownerToken, { customer: customerId, name: 'Shipper One Expansion', stage: 'qualified', estimatedValue: 50000 }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(lead.res.status, 201);

    const opportunity = await post('/api/crm/opportunities', ownerToken, { customer: customerId, lead: lead.body.lead._id, name: 'Dedicated Lanes', stage: 'proposal', amount: 120000 }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(opportunity.res.status, 201);

    const quote = await post('/api/crm/quotes', ownerToken, { customer: customerId, opportunity: opportunity.body.opportunity._id, lineItems: [{ description: 'Lane A', quantity: 2, rate: 1000 }] }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(quote.res.status, 201);
    assert.equal(quote.body.quote.subtotal, 2000);
    assert.equal(quote.body.quote.total, 2000);

    const agreement = await post('/api/crm/rate-agreements', ownerToken, { customer: customerId, name: '2026 Dry Van Lanes', status: 'active', lanes: [{ originCity: 'Dallas', originState: 'TX', destinationCity: 'Atlanta', destinationState: 'GA', rateType: 'flat', rateAmount: 2200 }] }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(agreement.res.status, 201);

    const crossCustomer = await get(`/api/crm/customers/${customerId}`, outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(crossCustomer.res.status, 403);
    assert.equal(crossCustomer.body.code, 'FORBIDDEN_TENANT_ACCESS');

    const crossList = await get('/api/crm/customers', outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(crossList.res.status, 200);
    assert.equal(crossList.body.count, 0);

    const crossContact = await post('/api/crm/contacts', outsiderToken, { customer: customerId, name: 'Intruder' }, { 'X-Company-Id': String(companyB._id) });
    assert.equal(crossContact.res.status, 403);
    assert.equal(crossContact.body.code, 'FORBIDDEN_TENANT_ACCESS');
  });

  it('records communication history and pipeline stage changes in the audit trail', async () => {
    const customer = await post('/api/crm/customers', ownerToken, { name: 'Shipper Two' }, { 'X-Company-Id': String(companyA._id) });
    const contact = await post('/api/crm/contacts', ownerToken, { customer: customer.body.customer._id, name: 'Sam Ops' }, { 'X-Company-Id': String(companyA._id) });

    const comm = await post(`/api/crm/contacts/${contact.body.contact._id}/communications`, ownerToken, { type: 'call', subject: 'Rate check', body: 'Discussed Q3 volumes' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(comm.res.status, 201);
    assert.equal(comm.body.contact.communications.length, 1);

    const lead = await post('/api/crm/leads', ownerToken, { name: 'Shipper Two Lead', stage: 'new' }, { 'X-Company-Id': String(companyA._id) });
    const stage = await patch(`/api/crm/leads/${lead.body.lead._id}`, ownerToken, { stage: 'proposal' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(stage.res.status, 200);
    assert.equal(stage.body.lead.stage, 'proposal');

    const activities = await post(`/api/crm/leads/${lead.body.lead._id}/activities`, ownerToken, { type: 'follow_up', subject: 'Follow up Friday', dueAt: new Date(Date.now() + 86400000).toISOString() }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(activities.res.status, 201);
    assert.equal(activities.body.lead.activities.length, 1);

    const audit = await AuditEvent.find({ company: companyA._id, action: { $in: ['CUSTOMER_CREATED', 'CONTACT_COMMUNICATION_LOGGED', 'LEAD_STAGE_UPDATED', 'LEAD_ACTIVITY_LOGGED'] } }).lean();
    const actions = audit.map((entry) => entry.action);
    assert.ok(actions.includes('CUSTOMER_CREATED'));
    assert.ok(actions.includes('CONTACT_COMMUNICATION_LOGGED'));
    assert.ok(actions.includes('LEAD_STAGE_UPDATED'));
    assert.ok(actions.includes('LEAD_ACTIVITY_LOGGED'));
  });

  it('removes customers and contacts only within the active company', async () => {
    const customer = await post('/api/crm/customers', ownerToken, { name: 'Temporary Shipper' }, { 'X-Company-Id': String(companyA._id) });
    const contact = await post('/api/crm/contacts', ownerToken, { customer: customer.body.customer._id, name: 'Temp Contact' }, { 'X-Company-Id': String(companyA._id) });

    const crossDelete = await del(`/api/crm/customers/${customer.body.customer._id}`, outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(crossDelete.res.status, 403);

    const contactDelete = await del(`/api/crm/contacts/${contact.body.contact._id}`, ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(contactDelete.res.status, 200);

    const customerDelete = await del(`/api/crm/customers/${customer.body.customer._id}`, ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(customerDelete.res.status, 200);

    assert.equal(await Contact.countDocuments({ company: companyA._id }), 2);
  });
});

describe('TMS workflows: stops, tenders, milestones and financials', () => {
  let loadA;
  let loadB;
  let carrierA;

  before(async () => {
    loadA = await Load.create({
      company: companyA._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'CREATED',
      loadNumber: 'TMS-A-' + Date.now(), shipperName: 'Shipper One',
      origin: { city: 'Dallas', state: 'TX' }, destination: { city: 'Atlanta', state: 'GA' },
      commodity: 'Paper', equipmentType: 'DRY_VAN', declaredCargoValue: 50000, status: 'POSTED',
    });
    loadB = await Load.create({
      company: companyB._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'CREATED',
      loadNumber: 'TMS-B-' + Date.now(), shipperName: 'Shipper Two',
      origin: { city: 'Miami', state: 'FL' }, destination: { city: 'Orlando', state: 'FL' },
      commodity: 'Fruit', equipmentType: 'REEFER', targetTemperature: 34, declaredCargoValue: 30000, status: 'POSTED',
    });
    carrierA = await Carrier.create({
      company: companyA._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'MIGRATED',
      legalName: 'TMS Carrier A', dotNumber: '900001', mcNumber: 'MC-900001', authorityStatus: 'ACTIVE',
      authorityGrantDate: new Date('2015-01-01'), safetyRating: 'SATISFACTORY', overallStatus: 'PASS',
      insurancePolicies: [{
        policyType: 'AUTO_LIABILITY', insuranceProvider: 'Acme Insurance', policyNumber: 'POL-1',
        coverageLimit: 1000000, effectiveDate: new Date('2025-01-01'), expirationDate: new Date(Date.now() + 31 * 86400000),
      }],
    });
  });

  it('manages ordered stops with appointment windows and status transitions', async () => {
    const first = await post(`/api/tms/loads/${loadA._id}/stops`, ownerToken, { sequence: 1, type: 'pickup', name: 'Shipper Dock', address: { city: 'Dallas', state: 'TX' }, appointmentStart: new Date(Date.now() + 3600000).toISOString() }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(first.res.status, 201);

    const duplicate = await post(`/api/tms/loads/${loadA._id}/stops`, ownerToken, { sequence: 1, type: 'delivery' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(duplicate.res.status, 409);
    assert.equal(duplicate.body.code, 'STOP_SEQUENCE_CONFLICT');

    const second = await post(`/api/tms/loads/${loadA._id}/stops`, ownerToken, { sequence: 2, type: 'delivery', name: 'Consignee' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(second.res.status, 201);

    const crossStop = await post(`/api/tms/loads/${loadB._id}/stops`, ownerToken, { sequence: 1, type: 'pickup' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(crossStop.res.status, 404);
    assert.equal(crossStop.body.code, 'LOAD_NOT_FOUND');

    const badTransition = await post(`/api/tms/stops/${second.body.stop._id}/status`, ownerToken, { status: 'completed' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(badTransition.res.status, 409);
    assert.equal(badTransition.body.code, 'INVALID_STOP_TRANSITION');

    const arrived = await post(`/api/tms/stops/${first.body.stop._id}/status`, ownerToken, { status: 'arrived' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(arrived.res.status, 200);
    assert.ok(arrived.body.stop.arrivedAt);

    const viewerArrive = await post(`/api/tms/stops/${second.body.stop._id}/status`, viewerToken, { status: 'arrived' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(viewerArrive.res.status, 403);
    assert.equal(viewerArrive.body.code, 'FORBIDDEN_ROLE');

    const list = await get(`/api/tms/loads/${loadA._id}/stops`, ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(list.res.status, 200);
    assert.equal(list.body.stops.length, 2);
    assert.equal(list.body.stops[0].sequence, 1);
  });

  it('tenders a load to a same-company carrier and blocks cross-company tenders', async () => {
    const crossCarrier = await Carrier.create({
      company: companyB._id, isDemoData: false, ownershipResolved: true, ownershipResolution: 'MIGRATED',
      legalName: 'TMS Carrier B', dotNumber: '900002', mcNumber: 'MC-900002', authorityStatus: 'ACTIVE',
      authorityGrantDate: new Date('2016-01-01'), safetyRating: 'SATISFACTORY', overallStatus: 'PASS',
      insurancePolicies: [],
    });

    const crossTender = await post(`/api/tms/loads/${loadA._id}/tenders`, ownerToken, { carrierId: String(crossCarrier._id) }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(crossTender.res.status, 404);
    assert.equal(crossTender.body.code, 'CARRIER_NOT_FOUND');

    const tender = await post(`/api/tms/loads/${loadA._id}/tenders`, ownerToken, { carrierId: String(carrierA._id), rateOffered: 2100 }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(tender.res.status, 201);
    assert.equal(tender.body.tender.status, 'tendered');

    const duplicate = await post(`/api/tms/loads/${loadA._id}/tenders`, ownerToken, { carrierId: String(carrierA._id) }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(duplicate.res.status, 409);
    assert.equal(duplicate.body.code, 'TENDER_ALREADY_OPEN');

    const badStatus = await patch(`/api/tms/tenders/${tender.body.tender._id}`, ownerToken, { status: 'accepted' }, { 'X-Company-Id': String(companyB._id) });
    assert.equal(badStatus.res.status, 403);

    const accepted = await patch(`/api/tms/tenders/${tender.body.tender._id}`, ownerToken, { status: 'accepted' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(accepted.res.status, 200);
    assert.ok(accepted.body.tender.respondedAt);

    // Awarding a tender must dispatch the load, not just close the tender.
    const awarded = await Load.findById(loadA._id);
    assert.equal(awarded.status, 'ASSIGNED');
    assert.equal(String(awarded.assignedCarrier), String(carrierA._id));
    assert.ok(awarded.assignedAt);
    assert.equal(String(awarded.assignedBy), String(owner.id));

    const again = await patch(`/api/tms/tenders/${tender.body.tender._id}`, ownerToken, { status: 'rejected' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(again.res.status, 409);
    assert.equal(again.body.code, 'TENDER_NOT_OPEN');
  });

  it('logs milestones/exceptions, changes load status and computes financial margins', async () => {
    const event = await post(`/api/tms/loads/${loadA._id}/events`, ownerToken, { type: 'exception', summary: 'Shipper running 2h late', details: { severity: 'warning' } }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(event.res.status, 201);

    const empty = await post(`/api/tms/loads/${loadA._id}/events`, ownerToken, {}, { 'X-Company-Id': String(companyA._id) });
    assert.equal(empty.res.status, 400);
    assert.equal(empty.body.code, 'EVENT_CONTENT_REQUIRED');

    const status = await patch(`/api/tms/loads/${loadA._id}/status`, ownerToken, { status: 'IN_TRANSIT', reason: 'Dispatched' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(status.res.status, 200);
    assert.equal(status.body.load.status, 'IN_TRANSIT');

    const badStatus = await patch(`/api/tms/loads/${loadA._id}/status`, ownerToken, { status: 'NOPE' }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(badStatus.res.status, 400);

    const financials = await put(`/api/tms/loads/${loadA._id}/financials`, ownerToken, { customerRate: 2500, carrierCost: 1800, accessorials: 100 }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(financials.res.status, 200);
    assert.equal(financials.body.financials.revenue, 2600);
    assert.equal(financials.body.financials.margin, 800);
    assert.equal(financials.body.financials.marginPct, 30.77);

    const invalid = await put(`/api/tms/loads/${loadA._id}/financials`, ownerToken, { carrierCost: -5 }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(invalid.res.status, 400);
    assert.equal(invalid.body.code, 'INVALID_AMOUNT');

    const crossFinancials = await get(`/api/tms/loads/${loadB._id}/financials`, ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(crossFinancials.res.status, 404);

    const events = await get(`/api/tms/loads/${loadA._id}/events`, ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(events.res.status, 200);
    const types = events.body.events.map((entry) => entry.type);
    assert.ok(types.includes('exception'));
    assert.ok(types.includes('status_change'));
    assert.ok(types.includes('financial'));
  });

  it('surfaces an operational exception queue scoped to the active company', async () => {
    const raised = await post(`/api/tms/loads/${loadA._id}/events`, ownerToken, {
      type: 'exception',
      summary: 'Driver breakdown',
      details: { severity: 'high' },
    }, { 'X-Company-Id': String(companyA._id) });
    assert.equal(raised.res.status, 201);

    const queue = await get('/api/tms/exceptions', ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(queue.res.status, 200);
    assert.equal(queue.body.success, true);
    assert.ok(queue.body.count >= 1);
    const row = queue.body.exceptions.find((entry) => entry.loadId === String(loadA._id));
    assert.ok(row, 'the raised exception must appear for the owning company');
    assert.equal(row.kind, 'exception');
    assert.equal(row.reason, 'exception');
    assert.equal(row.loadNumber, loadA.loadNumber);

    // A company outside the tenant must not see the queue at all.
    const cross = await get('/api/tms/exceptions', outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(cross.res.status, 200);
    assert.equal(cross.body.exceptions.some((entry) => entry.loadId === String(loadA._id)), false);

    // A read-only member of the company may triage, but a non-member may not.
    const viewerQueue = await get('/api/tms/exceptions', viewerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(viewerQueue.res.status, 200);
    assert.ok(viewerQueue.body.exceptions.every((entry) => entry.kind === 'exception'));

    const denied = await get('/api/tms/exceptions', outsiderToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(denied.res.status, 403);
  });

  it('scopes dashboard, activity history and reporting to the active company', async () => {
    const dashA = await get('/api/tms/dashboard', ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(dashA.res.status, 200);
    assert.ok(dashA.body.summary.loadsByStatus.some((row) => row.status === 'IN_TRANSIT'));
    assert.equal(dashA.body.summary.revenue, 2600);

    const dashB = await get('/api/tms/dashboard', outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(dashB.res.status, 200);
    assert.equal(dashB.body.summary.revenue, 0);

    const reportA = await get('/api/tms/reports/loads?status=IN_TRANSIT', ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(reportA.res.status, 200);
    assert.equal(reportA.body.count, 1);
    assert.equal(reportA.body.totals.margin, 800);

    const reportB = await get('/api/tms/reports/loads', outsiderToken, { 'X-Company-Id': String(companyB._id) });
    assert.equal(reportB.res.status, 200);
    assert.equal(reportB.body.count, 1);
    assert.equal(reportB.body.totals.revenue, 0);

    const activity = await get('/api/tms/activity', ownerToken, { 'X-Company-Id': String(companyA._id) });
    assert.equal(activity.res.status, 200);
    assert.ok(activity.body.events.every((entry) => String(entry.company) === String(companyA._id)));

    const anon = await get('/api/tms/dashboard');
    assert.equal(anon.res.status, 401);
  });
});