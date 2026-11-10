const Carrier = require('../models/Carrier');

/**
 * Migration helper for Carrier records without company ownership.
 *
 * Rules:
 * 1. Demo records (isDemoData === true or dotNumber starting with DEMO) are explicitly marked as isDemoData: true.
 *    Demo carriers are NOT arbitrarily assigned to a real company.
 * 2. If non-demo carriers exist without a company reference:
 *    - Never assign them to an arbitrary company.
 *    - Log an alert indicating manual administrative assignment or review is needed.
 *
 * Safe and idempotent.
 */
async function reconcileCarrierTenancy(options = {}) {
  const carrierModel = options.carrierModel || Carrier;
  const logger = options.logger || console;
  const result = {
    demoCarriersMarked: 0,
    companyCarriersMarkedProduction: 0,
    unownedProductionCarriers: 0
  };

  const updateDemo = await carrierModel.updateMany(
    {
      $or: [{ company: { $exists: false } }, { company: null }],
      dotNumber: /^DEMO(?:[-_]|$)/i,
      isDemoData: { $ne: true }
    },
    {
      $set: { isDemoData: true }
    }
  );
  result.demoCarriersMarked = updateDemo.modifiedCount || 0;

  const updateCompanyOwned = await carrierModel.updateMany(
    {
      company: { $type: 'objectId' },
      isDemoData: { $exists: false }
    },
    { $set: { isDemoData: false } }
  );
  result.companyCarriersMarkedProduction = updateCompanyOwned.modifiedCount || 0;

  const unownedProd = await carrierModel.countDocuments({
    $or: [{ company: { $exists: false } }, { company: null }],
    isDemoData: { $ne: true }
  });
  result.unownedProductionCarriers = unownedProd;

  if (unownedProd > 0) {
    logger.warn(`[CarrierTenancy] WARNING: Found ${unownedProd} carrier(s) without reliable company ownership. They were left unchanged for administrative review.`);
  }

  return result;
}

module.exports = { reconcileCarrierTenancy };
