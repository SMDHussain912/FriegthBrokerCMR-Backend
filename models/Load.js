const mongoose = require('mongoose');

const loadSchema = new mongoose.Schema({
  loadNumber: {
    type: String,
    required: [true, 'Load number is required'],
    unique: true,
    trim: true,
    index: true
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
  // Clearly labelled demo data identifier
  isDemoData: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Load', loadSchema);
