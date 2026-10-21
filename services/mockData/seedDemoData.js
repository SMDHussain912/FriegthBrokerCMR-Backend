require('dotenv').config();
const mongoose = require('mongoose');
const Carrier = require('../../models/Carrier');
const Load = require('../../models/Load');
const User = require('../../models/User');
const { DEMO_CARRIERS, DEMO_LOADS } = require('./fmcsaDemoData');

// Clearly labelled demo login accounts (passwords documented for local demo only)
const DEMO_USERS = [
  { name: 'Demo Broker', email: 'broker.demo@ricoz.local', password: 'Broker123!', role: 'broker' },
  { name: 'Demo Compliance Officer', email: 'compliance.demo@ricoz.local', password: 'Compliance123!', role: 'compliance_officer' },
  { name: 'Demo Admin', email: 'admin.demo@ricoz.local', password: 'Admin123!', role: 'admin' }
];

const seedDatabase = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/freight_crm';
  console.log(`[Seed Script] Connecting to MongoDB: ${mongoUri}`);

  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('[Seed Script] Refusing to run: demo seeding is disabled in production.');
    process.exit(1);
    return;
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('[Seed Script] Connected successfully.');

    // Clear existing demo records only
    const deletedCarriers = await Carrier.deleteMany({ isDemoData: true });
    const deletedLoads = await Load.deleteMany({ isDemoData: true });
    console.log(`[Seed Script] Cleared ${deletedCarriers.deletedCount} old demo carriers and ${deletedLoads.deletedCount} demo loads.`);

    // Insert demo carriers
    const insertedCarriers = await Carrier.insertMany(DEMO_CARRIERS);
    console.log(`[Seed Script] Inserted ${insertedCarriers.length} clearly labelled demo carriers:`);
    insertedCarriers.forEach(c => {
      console.log(`   * [DOT ${c.dotNumber}] ${c.legalName} (${c.authorityStatus})`);
    });

    // Insert demo loads
    const insertedLoads = await Load.insertMany(DEMO_LOADS);
    console.log(`[Seed Script] Inserted ${insertedLoads.length} clearly labelled demo loads:`);
    insertedLoads.forEach(l => {
      console.log(`   * [${l.loadNumber}] ${l.commodity} (${l.equipmentType}, Value: $${l.declaredCargoValue.toLocaleString()})`);
    });

    // Upsert clearly labelled demo users (bcrypt-hashed passwords)
    for (const demo of DEMO_USERS) {
      const passwordHash = await User.hashPassword(demo.password);
      await User.findOneAndUpdate(
        { email: demo.email },
        { name: demo.name, email: demo.email, passwordHash, role: demo.role, isDemoData: true },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      console.log(`   * [DEMO USER] ${demo.email} (${demo.role}) password: ${demo.password}`);
    }

    console.log('[Seed Script] Seeding complete.');
    process.exit(0);
  } catch (error) {
    console.error(`[Seed Script Error]: ${error.message}`);
    process.exit(1);
  }
};

if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
