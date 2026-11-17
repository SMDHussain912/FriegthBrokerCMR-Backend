const mongoose = require('mongoose');
const Load = require('../models/Load');

/**
 * Load ownership migration (Task 1.2)
 *
 * Dry-run (default): reports how existing loads would be classified without mutating records.
 * Execute: applies only safe, evidence-backed changes:
 *   - marks explicit demo loads (isDemoData=true) as ownershipResolved=true/resolution=DEMO.
 *   - records unresolved legacy production loads (no reliable company evidence) as unresolved/quarantined metadata.
 * Does NOT assign any company ownership without reliable evidence.
 *
 * Idempotent: repeated runs produce the same state and zero additional mutations once converged.
 */
async function reconcileLoadTenancy({ apply = false, logger = console } = {}) {
  const report = {
    apply: Boolean(apply),
    scanned: 0,
    demoResolved: 0,
    demoAlreadyResolved: 0,
    unresolvedLegacy: 0,
    unresolvedLegacyAlreadyMarked: 0,
    companyOwnedResolved: 0,
    companyOwnedAlreadyResolved: 0,
    mutated: 0,
    unresolvedSamples: []
  };

  const cursor = Load.find({}).select('_id loadNumber company isDemoData ownershipResolved ownershipResolution ownershipResolvedAt').cursor();
  for await (const load of cursor) {
    report.scanned += 1;
    const isDemo = load.isDemoData === true;
    const hasCompany = Boolean(load.company && mongoose.Types.ObjectId.isValid(String(load.company)));

    if (isDemo) {
      if (load.ownershipResolved === true && load.ownershipResolution === 'DEMO' && !load.company) {
        report.demoAlreadyResolved += 1;
      } else {
        report.demoResolved += 1;
        if (apply) {
          load.company = undefined;
          load.ownershipResolved = true;
          load.ownershipResolution = 'DEMO';
          load.ownershipResolvedAt = load.ownershipResolvedAt || new Date();
          await load.save();
          report.mutated += 1;
        }
      }
      continue;
    }

    if (hasCompany) {
      if (load.ownershipResolved === true && load.ownershipResolution && load.ownershipResolution !== 'UNRESOLVED') {
        report.companyOwnedAlreadyResolved += 1;
      } else {
        report.companyOwnedResolved += 1;
        if (apply) {
          load.ownershipResolved = true;
          load.ownershipResolution = load.ownershipResolution && load.ownershipResolution !== 'UNRESOLVED' ? load.ownershipResolution : 'MIGRATED';
          load.ownershipResolvedAt = load.ownershipResolvedAt || new Date();
          await load.save();
          report.mutated += 1;
        }
      }
      continue;
    }

    // No reliable evidence of owning company: quarantine/unavailable to company-scoped operations.
    if (load.ownershipResolved === false && load.ownershipResolution === 'UNRESOLVED') {
      report.unresolvedLegacyAlreadyMarked += 1;
    } else {
      report.unresolvedLegacy += 1;
      if (apply) {
        load.ownershipResolved = false;
        load.ownershipResolution = 'UNRESOLVED';
        load.ownershipResolvedAt = undefined;
        load.company = undefined;
        await load.save();
        report.mutated += 1;
      }
    }
    if (report.unresolvedSamples.length < 20) {
      report.unresolvedSamples.push({ id: String(load._id), loadNumber: load.loadNumber });
    }
  }

  if (logger && typeof logger.info === 'function') {
    logger.info('[load-migration] tenancy reconciliation', report);
  } else if (logger && typeof logger.log === 'function') {
    logger.log('[load-migration] tenancy reconciliation', report);
  }
  return report;
}

async function runLoadTenancyMigrationCli() {
  const apply = process.argv.includes('--apply');
  const mongooseLib = require('mongoose');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/freight_broker_crm';
  await mongooseLib.connect(uri);
  try {
    const report = await reconcileLoadTenancy({ apply, logger: console });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongooseLib.disconnect();
  }
}

if (require.main === module) {
  runLoadTenancyMigrationCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  reconcileLoadTenancy,
  runLoadTenancyMigrationCli
};
