const mongoose = require('mongoose');

const loadSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    index: true
  },
  ownershipResolved: {
    type: Boolean,
    default: false
  },
  ownershipResolvedAt: {
    type: Date
  },
  ownershipResolution: {
    type: String,
    enum: ['DEMO', 'MIGRATED', 'UNRESOLVED', 'MANUAL', 'CREATED'],
    default: 'UNRESOLVED'
  },
  loadNumber: {
    type: String,
    required: [true, 'Load number is required'],
    trim: true
  },
  shipperName: {
    type: String,
    required: [true, 'Shipper name is required'],
    trim: true
  },
  origin: {
    city: { type: String, required: [true, 'Origin city is required'], trim: true },
    state: { type: String, required: [true, 'Origin state is required'], trim: true },
    pickupDate: { type: Date }
  },
  destination: {
    city: { type: String, required: [true, 'Destination city is required'], trim: true },
    state: { type: String, required: [true, 'Destination state is required'], trim: true },
    deliveryDate: { type: Date }
  },
  commodity: {
    type: String,
    required: [true, 'Commodity description is required'],
    trim: true
  },
  equipmentType: {
    type: String,
    enum: ['DRY_VAN', 'REEFER', 'FLATBED'],
    required: [true, 'Equipment type is required']
  },
  targetTemperature: {
    type: Number,
    validate: {
      validator: function(val) {
        if (this.equipmentType === 'REEFER') {
          return val !== undefined && val !== null;
        }
        return true;
      },
      message: 'Target temperature is required for refrigerated (REEFER) freight'
    }
  },
  customerRate: {
    type: Number,
    min: [0, 'Customer rate cannot be negative']
  },
  carrierCost: {
    type: Number,
    min: [0, 'Carrier cost cannot be negative']
  },
  accessorials: {
    type: Number,
    min: [0, 'Accessorials cannot be negative'],
    default: 0
  },
  currency: {
    type: String,
    trim: true,
    uppercase: true,
    default: 'USD'
  },
  notes: {
    type: String,
    trim: true
  },
  declaredCargoValue: {
    type: Number,
    required: [true, 'Declared cargo value is required'],
    min: [0, 'Declared cargo value cannot be negative']
  },
  loadRequirements: {
    minAuthorityAgeDays: { type: Number, default: 90, min: 0 },
    minAutoLiability: { type: Number, default: 1000000, min: 0 },
    requireReeferEndorsement: { type: Boolean, default: false },
    disallowConditionalSafety: { type: Boolean, default: true },
    maxUnsafeDrivingPercentile: { type: Number, default: 75, min: 0, max: 100 }
  },
  status: {
    type: String,
    enum: ['POSTED', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
    default: 'POSTED',
    index: true
  },
  assignedCarrier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Carrier'
  },
  assignedAt: {
    type: Date
  },
  assignedBy: {
    type: String,
    trim: true
  },
  auditSnapshotId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CarrierAssignment'
  },
  isDemoData: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Demo loads: globally unique load numbers within demo dataset.
loadSchema.index(
  { loadNumber: 1 },
  { unique: true, name: 'loadNumber_demo_unique', partialFilterExpression: { isDemoData: true } }
);
// Company loads: unique per company when ownership is resolved.
loadSchema.index(
  { company: 1, loadNumber: 1 },
  { unique: true, name: 'company_loadNumber_unique', partialFilterExpression: { company: { $exists: true, $type: 'objectId' }, isDemoData: false } }
);
loadSchema.index({ company: 1, status: 1, createdAt: -1 });
loadSchema.index({ isDemoData: 1, status: 1, createdAt: -1 });
loadSchema.index({ ownershipResolved: 1, isDemoData: 1, company: 1 });

module.exports = mongoose.model('Load', loadSchema);
