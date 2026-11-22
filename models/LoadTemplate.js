const mongoose = require('mongoose');

/**
 * Load Template Model - Reusable load configurations
 * Supports recurring loads and quick load creation from templates
 */

const loadTemplateSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  // Template data (same fields as Load but optional)
  shipperName: { type: String, trim: true },
  origin: {
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pickupAddress: { type: String, trim: true },
    pickupContact: { type: String, trim: true },
    pickupPhone: { type: String, trim: true },
    pickupEmail: { type: String, trim: true, lowercase: true }
  },
  destination: {
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    deliveryAddress: { type: String, trim: true },
    deliveryContact: { type: String, trim: true },
    deliveryPhone: { type: String, trim: true },
    deliveryEmail: { type: String, trim: true, lowercase: true }
  },
  commodity: { type: String, trim: true },
  equipmentType: { type: String, enum: ['DRY_VAN', 'REEFER', 'FLATBED', 'TANKER', 'STEP_DECK', 'DOUBLE_DROP'] },
  targetTemperature: { type: Number },
  customerRate: { type: Number, min: 0 },
  carrierCost: { type: Number, min: 0 },
  accessorials: { type: Number, min: 0, default: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'USD' },
  notes: { type: String, trim: true },
  declaredCargoValue: { type: Number, min: 0 },
  loadRequirements: {
    minAuthorityAgeDays: { type: Number, default: 90, min: 0 },
    minAutoLiability: { type: Number, default: 1000000, min: 0 },
    requireReeferEndorsement: { type: Boolean, default: false },
    disallowConditionalSafety: { type: Boolean, default: true },
    maxUnsafeDrivingPercentile: { type: Number, default: 75, min: 0, max: 100 }
  },
  // Recurring schedule
  isRecurring: { type: Boolean, default: false },
  recurrence: {
    frequency: { type: String, enum: ['daily', 'weekly', 'biweekly', 'monthly'] },
    daysOfWeek: [{ type: Number, min: 0, max: 6 }], // 0=Sunday
    dayOfMonth: { type: Number, min: 1, max: 31 },
    startDate: { type: Date },
    endDate: { type: Date },
    timezone: { type: String, default: 'America/Chicago' }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isActive: { type: Boolean, default: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

loadTemplateSchema.index({ company: 1, isActive: 1, name: 1 });
loadTemplateSchema.index({ company: 1, isRecurring: 1, isActive: 1 });

/**
 * Create a load from template
 * @param {ObjectId} templateId - Template ID
 * @param {Object} overrides - Field overrides for this load
 * @returns {Promise<Object>} Load data ready for creation
 */
loadTemplateSchema.statics.createLoadFromTemplate = async function(templateId, overrides = {}) {
  const template = await this.findById(templateId);
  if (!template || !template.isActive) {
    throw new Error('Template not found or inactive');
  }
  
  const templateObj = template.toObject();
  delete templateObj._id;
  delete templateObj.company;
  delete templateObj.createdAt;
  delete templateObj.updatedAt;
  delete templateObj.__v;
  delete templateObj.isRecurring;
  delete templateObj.recurrence;
  
  // Apply overrides
  const loadData = { ...templateObj, ...overrides };
  
  return loadData;
};

/**
 * Get next occurrence date for recurring template
 * @param {Object} recurrence - Recurrence configuration
 * @param {Date} fromDate - Starting date
 * @returns {Date|null} Next occurrence or null if ended
 */
loadTemplateSchema.statics.getNextOccurrence = function(recurrence, fromDate = new Date()) {
  if (!recurrence || !recurrence.frequency) return null;
  if (recurrence.endDate && new Date(recurrence.endDate) < fromDate) return null;
  
  const next = new Date(fromDate);
  const start = recurrence.startDate ? new Date(recurrence.startDate) : fromDate;
  if (next < start) next.setTime(start.getTime());
  
  switch (recurrence.frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      if (recurrence.daysOfWeek?.length) {
        const currentDay = next.getDay();
        const nextDay = recurrence.daysOfWeek.find(d => d > currentDay) || recurrence.daysOfWeek[0];
        const daysAhead = nextDay > currentDay ? nextDay - currentDay : 7 - currentDay + nextDay;
        next.setDate(next.getDate() + daysAhead);
      } else {
        next.setDate(next.getDate() + 7);
      }
      break;
    case 'biweekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      if (recurrence.dayOfMonth) {
        next.setDate(recurrence.dayOfMonth);
      }
      break;
  }
  
  if (recurrence.endDate && next > new Date(recurrence.endDate)) return null;
  return next;
};

module.exports = mongoose.model('LoadTemplate', loadTemplateSchema);