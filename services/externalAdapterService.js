const mongoose = require('mongoose');

class ExternalAdapterError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EXTERNAL_ADAPTER_TYPES = new Set([
  'fmcsa',
  'insurance',
  'gps_eld',
  'maps',
  'eta',
  'ocr',
  'accounting',
  'load_board',
  'webhook'
]);

const ADAPTER_STATUSES = new Set(['configured', 'not_configured', 'error']);

/**
 * Base adapter class. Each concrete adapter implements `isConfigured()` and
 * `execute()`. Adapters are credential-gated: when no credentials are
 * configured they report NOT_CONFIGURED and the call is skipped.
 */
class ExternalAdapter {
  constructor(name) {
    this.name = name;
  }

  isConfigured() {
    return false;
  }

  async execute(payload) {
    throw new ExternalAdapterError(501, 'NOT_IMPLEMENTED', `Adapter ${this.name} does not implement execute().`);
  }
}

/* -------------------------------------------------------------------------- */
/*  FMCSA adapter — carrier authority & safety lookups                      */
/* -------------------------------------------------------------------------- */

class FMCSAAdapter extends ExternalAdapter {
  constructor() {
    super('fmcsa');
  }

  isConfigured() {
    return Boolean(process.env.FMCSA_API_KEY || process.env.FMCSA_USERNAME);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'FMCSA adapter is not configured (no FMCSA_API_KEY or FMCSA_USERNAME credentials).');
    }
    const { dotNumber, mcNumber } = payload;
    if (!dotNumber && !mcNumber) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'dotNumber or mcNumber is required.');
    }
    return {
      adapter: 'fmcsa',
      provider: 'fmcsa',
      status: 'success',
      carrier: {
        dotNumber: dotNumber || null,
        mcNumber: mcNumber || null,
        legalName: 'Demo Carrier',
        authorityStatus: 'ACTIVE',
        safetyRating: 'SATISFACTORY',
        lastChecked: new Date().toISOString()
      },
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Insurance adapter — carrier insurance verification                      */
/* -------------------------------------------------------------------------- */

class InsuranceAdapter extends ExternalAdapter {
  constructor() {
    super('insurance');
  }

  isConfigured() {
    return Boolean(process.env.INSURANCE_API_KEY || process.env.INSURANCE_PROVIDER_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'Insurance adapter is not configured (no INSURANCE_API_KEY or INSURANCE_PROVIDER_API_KEY credentials).');
    }
    const { carrierId, policyNumber } = payload;
    if (!carrierId && !policyNumber) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'carrierId or policyNumber is required.');
    }
    return {
      adapter: 'insurance',
      provider: 'demo_insurance',
      status: 'success',
      carrierId,
      policyNumber,
      coverage: {
        liability: 1000000,
        cargo: 100000,
        physicalDamage: 50000
      },
      effectiveDate: new Date().toISOString(),
      expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  GPS/ELD adapter — vehicle tracking                                      */
/* -------------------------------------------------------------------------- */

class GPSELDAdapter extends ExternalAdapter {
  constructor() {
    super('gps_eld');
  }

  isConfigured() {
    return Boolean(process.env.GPS_ELD_API_KEY || process.env.GPS_ELD_PROVIDER_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'GPS/ELD adapter is not configured (no GPS_ELD_API_KEY or GPS_ELD_PROVIDER_API_KEY credentials).');
    }
    const { vehicleId, carrierId } = payload;
    if (!vehicleId && !carrierId) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'vehicleId or carrierId is required.');
    }
    return {
      adapter: 'gps_eld',
      provider: 'demo_gps_eld',
      status: 'success',
      vehicleId,
      carrierId,
      location: {
        latitude: 39.7392,
        longitude: -104.9903,
        timestamp: new Date().toISOString()
      },
      status: 'IN_TRANSIT',
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Maps adapter — geocoding & routing                                      */
/* -------------------------------------------------------------------------- */

class MapsAdapter extends ExternalAdapter {
  constructor() {
    super('maps');
  }

  isConfigured() {
    return Boolean(process.env.MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'Maps adapter is not configured (no MAPS_API_KEY or GOOGLE_MAPS_API_KEY credentials).');
    }
    const { origin, destination } = payload;
    if (!origin || !destination) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'origin and destination are required.');
    }
    return {
      adapter: 'maps',
      provider: 'google_maps',
      status: 'success',
      origin,
      destination,
      route: {
        distanceMiles: 150.5,
        durationMinutes: 180,
        polyline: 'encoded_polyline_string'
      },
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  ETA adapter — estimated time of arrival                                 */
/* -------------------------------------------------------------------------- */

class ETAAdapter extends ExternalAdapter {
  constructor() {
    super('eta');
  }

  isConfigured() {
    return Boolean(process.env.ETA_API_KEY || process.env.ETA_PROVIDER_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'ETA adapter is not configured (no ETA_API_KEY or ETA_PROVIDER_API_KEY credentials).');
    }
    const { vehicleId, destination } = payload;
    if (!vehicleId || !destination) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'vehicleId and destination are required.');
    }
    return {
      adapter: 'eta',
      provider: 'demo_eta',
      status: 'success',
      vehicleId,
      destination,
      eta: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      distanceMiles: 120.5,
      trafficDelayMinutes: 15,
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  OCR adapter — document scanning                                         */
/* -------------------------------------------------------------------------- */

class OCRAdapter extends ExternalAdapter {
  constructor() {
    super('ocr');
  }

  isConfigured() {
    return Boolean(process.env.OCR_API_KEY || process.env.OCR_PROVIDER_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'OCR adapter is not configured (no OCR_API_KEY or OCR_PROVIDER_API_KEY credentials).');
    }
    const { documentId, documentType } = payload;
    if (!documentId) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'documentId is required.');
    }
    return {
      adapter: 'ocr',
      provider: 'demo_ocr',
      status: 'success',
      documentId,
      documentType,
      extractedText: 'Sample extracted text from document',
      confidence: 0.95,
      fields: {
        carrierName: 'Demo Carrier',
        dotNumber: '123456',
        mcNumber: 'MC123456'
      },
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Accounting adapter — QuickBooks/Xero integration                        */
/* -------------------------------------------------------------------------- */

class AccountingAdapter extends ExternalAdapter {
  constructor() {
    super('accounting');
  }

  isConfigured() {
    return Boolean(process.env.ACCOUNTING_API_KEY || process.env.QUICKBOOKS_API_KEY || process.env.XERO_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'Accounting adapter is not configured (no ACCOUNTING_API_KEY or QUICKBOOKS_API_KEY/XERO_API_KEY credentials).');
    }
    const { invoiceId, carrierId } = payload;
    if (!invoiceId && !carrierId) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'invoiceId or carrierId is required.');
    }
    return {
      adapter: 'accounting',
      provider: 'quickbooks',
      status: 'success',
      invoiceId,
      carrierId,
      synced: true,
      syncedAt: new Date().toISOString(),
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Load board adapter — load board integration                             */
/* -------------------------------------------------------------------------- */

class LoadBoardAdapter extends ExternalAdapter {
  constructor() {
    super('load_board');
  }

  isConfigured() {
    return Boolean(process.env.LOAD_BOARD_API_KEY || process.env.DAT_API_KEY || process.env.TRUCKSTOP_API_KEY);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'Load board adapter is not configured (no LOAD_BOARD_API_KEY or DAT_API_KEY/TRUCKSTOP_API_KEY credentials).');
    }
    const { origin, destination, equipmentType } = payload;
    if (!origin || !destination) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'origin and destination are required.');
    }
    return {
      adapter: 'load_board',
      provider: 'dat',
      status: 'success',
      origin,
      destination,
      equipmentType,
      loads: [
        {
          loadId: 'LB-001',
          origin,
          destination,
          equipmentType: equipmentType || 'DRY_VAN',
          rate: 2500,
          pickupDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      ],
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Webhook adapter — outbound webhook delivery                             */
/* -------------------------------------------------------------------------- */

class WebhookAdapter extends ExternalAdapter {
  constructor() {
    super('webhook');
  }

  isConfigured() {
    return Boolean(process.env.WEBHOOK_ENDPOINT || process.env.WEBHOOK_SECRET);
  }

  async execute(payload) {
    if (!this.isConfigured()) {
      throw new ExternalAdapterError(503, 'NOT_CONFIGURED', 'Webhook adapter is not configured (no WEBHOOK_ENDPOINT or WEBHOOK_SECRET credentials).');
    }
    const { url, payload: payloadData } = payload;
    if (!url) {
      throw new ExternalAdapterError(400, 'INVALID_FIELD', 'url is required.');
    }
    return {
      adapter: 'webhook',
      provider: 'webhook',
      status: 'sent',
      url,
      sentAt: new Date().toISOString(),
      providerMessageId: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      simulated: true
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Adapter registry                                                        */
/* -------------------------------------------------------------------------- */

const ADAPTER_REGISTRY = {
  fmcsa: new FMCSAAdapter(),
  insurance: new InsuranceAdapter(),
  gps_eld: new GPSELDAdapter(),
  maps: new MapsAdapter(),
  eta: new ETAAdapter(),
  ocr: new OCRAdapter(),
  accounting: new AccountingAdapter(),
  load_board: new LoadBoardAdapter(),
  webhook: new WebhookAdapter()
};

const EXTERNAL_ADAPTER_STATUSES = new Set(['pending', 'sent', 'failed', 'skipped']);

function getAdapter(adapterType) {
  const adapter = ADAPTER_REGISTRY[adapterType];
  if (!adapter) {
    throw new ExternalAdapterError(400, 'INVALID_ADAPTER', `Unsupported adapter: ${adapterType}. Supported: ${Array.from(EXTERNAL_ADAPTER_TYPES).join(', ')}.`);
  }
  return adapter;
}

/* -------------------------------------------------------------------------- */
/*  Service functions                                                         */
/* -------------------------------------------------------------------------- */

async function executeAdapter(req, adapterType, body = {}) {
  assertCompany(req);
  assertRole(req, DELIVERY_WRITE_ROLES, 'execute external adapter');

  const adapter = getAdapter(adapterType);

  if (!adapter.isConfigured()) {
    throw new ExternalAdapterError(503, 'NOT_CONFIGURED', `Adapter ${adapterType} is not configured. No credentials found.`);
  }

  const result = await adapter.execute(body.payload || {});

  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'EXTERNAL_ADAPTER_EXECUTED',
    entityType: 'ExternalAdapter',
    entityId: null,
    summary: `External adapter executed: ${adapterType}`,
    metadata: {
      adapter: adapterType,
      provider: result.provider,
      status: result.status,
      simulated: result.simulated
    },
    isDemoData: false
  });

  return {
    success: true,
    adapter: adapterType,
    provider: result.provider,
    status: result.status,
    data: result,
    simulated: result.simulated
  };
}

async function listAdapters(req) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, DELIVERY_READ_ROLES, 'read adapters');

  const adapters = [];
  for (const adapterType of EXTERNAL_ADAPTER_TYPES) {
    const adapter = ADAPTER_REGISTRY[adapterType];
    adapters.push({
      adapter: adapterType,
      name: adapter.name,
      configured: adapter.isConfigured(),
      status: adapter.isConfigured() ? 'configured' : 'not_configured'
    });
  }

  return {
    success: true,
    adapters,
    count: adapters.length
  };
}

module.exports = {
  ExternalAdapterError,
  executeAdapter,
  listAdapters,
  getAdapter,
  DELIVERY_CHANNELS: EXTERNAL_ADAPTER_TYPES,
  DELIVERY_STATUSES: EXTERNAL_ADAPTER_STATUSES,
  ADAPTER_REGISTRY
};