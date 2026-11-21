const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('./app');
const { signToken } = require('./middleware/auth');
const { dropTestDatabase } = require('./helpers/testDb');

const TEST_DB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://localhost:27017/freight_crm_notify_debug_' + process.pid;

let server, baseUrl, ownerId, ownerToken, companyA;
const insert = (model, doc) => mongoose.connection.collection(model).insertOne(doc);

before(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.asPromise();
  const passHash = await (require('./models/User')).hashPassword('Test123!');
  const uRes = await insert('users', { name: 'Owner', email: 'dbg-owner@test.local', passwordHash: passHash, role: 'broker_owner' });
  ownerId = uRes.insertedId;
  ownerToken = signToken({ _id: ownerId, email: 'dbg-owner@test.local', role: 'broker_owner' });
  companyA = (await insert('companies', { name: 'Debug Co', slug: 'dbg-' + Date.now(), type: 'brokerage', owner: ownerId })).insertedId;
  await insert('memberships', { user: ownerId, company: companyA, role: 'broker_owner', isActive: true });
  await insert('notifications', { user: ownerId, company: companyA, type: 'info', title: 'Test Notification', message: 'Test message', isRead: false, isDemoData: false });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
});

after(async () => {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch {}
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await dropTestDatabase(TEST_DB_URI, mongoose.connection.name);
});

const getReq = async (path, token, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers } });
  return { res, status: res.status, json: async () => await res.json() };
};

describe('Debug Notifications', () => {
  it('lists notifications', async () => {
    const { status, json } = await getReq('/api/notifications', ownerToken, { 'X-Company-Id': String(companyA) });
    console.log('STATUS:', status);
    console.log('KEYS:', Object.keys(json));
    console.log('NOTIFICATIONS:', JSON.stringify(json.notifications));
    console.log('TYPE:', typeof json.notifications, 'IS ARRAY:', Array.isArray(json.notifications));
    console.log('FIRST:', json.notifications[0]);
  });
});
