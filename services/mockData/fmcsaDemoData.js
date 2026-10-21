/**
 * Clearly Labelled Mock Data for Demo and Local Testing
 * 
 * DISCLAIMER: All entities, policy numbers, and safety ratings below are simulated demo data.
 * No live FMCSA queries or real-world insurance policy verifications are executed.
 */

const getPastDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
};

const getFutureDate = (daysAhead) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
};

const DEMO_CARRIERS = [
  {
    dotNumber: '2849102',
    mcNumber: 'MC-981240',
    legalName: 'Apex Freight Logistics LLC',
    dbaName: 'Apex Cold Chain',
    contact: {
      phone: '(555) 301-4491',
      email: 'dispatch@apexfreightlogistics.com',
      address: { street: '1400 Industrial Pkwy', city: 'Bakersfield', state: 'CA', zip: '93308' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(450), // 450 days tenure
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 18,
      hosCompliancePercentile: 24,
      vehicleMaintPercentile: 12,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(2) // Fresh: 2 days ago
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'PASS',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Travelers Indemnity Co',
        policyNumber: 'TRV-AUTO-894120',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(120),
        expirationDate: getFutureDate(245),
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(10),
        producerContact: { name: 'Acme Agency', phone: '(555) 201-9900', email: 'service@acmeagency.com' }
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Great West Casualty Co',
        policyNumber: 'GWC-CARGO-449210',
        coverageLimit: 250000,
        effectiveDate: getPastDate(120),
        expirationDate: getFutureDate(245),
        reeferBreakdownEndorsement: true, // Active Reefer Endorsement
        hasUnattendedVehicleClause: false,
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(10),
        producerContact: { name: 'Acme Agency', phone: '(555) 201-9900', email: 'service@acmeagency.com' }
      }
    ]
  },
  {
    dotNumber: '3109281',
    mcNumber: 'MC-1049281',
    legalName: 'Sub-Par Transport Inc',
    dbaName: 'Sub-Par Hauling',
    contact: {
      phone: '(555) 492-1102',
      email: 'ops@subpartransport.com',
      address: { street: '782 Commerce Rd', city: 'Dallas', state: 'TX', zip: '75201' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(300),
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 45,
      hosCompliancePercentile: 50,
      vehicleMaintPercentile: 38,
      crashTotal: 1,
      lastFmcsaCheck: getPastDate(3)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'NEEDS_REVIEW',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Progressive Commercial',
        policyNumber: 'PRG-AUTO-991204',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(90),
        expirationDate: getFutureDate(275),
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(15)
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Nationwide Commercial',
        policyNumber: 'NW-CARGO-109240',
        coverageLimit: 100000, // Only $100k cargo limit! Insufficient for $200k load
        effectiveDate: getPastDate(90),
        expirationDate: getFutureDate(275),
        reeferBreakdownEndorsement: true,
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(15)
      }
    ]
  },
  {
    dotNumber: '2940192',
    mcNumber: 'MC-883910',
    legalName: 'Frozen Transit LLC',
    dbaName: 'Frozen Express',
    contact: {
      phone: '(555) 601-3829',
      email: 'dispatch@frozentransit.com',
      address: { street: '512 Glacier Way', city: 'Denver', state: 'CO', zip: '80202' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(210),
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 22,
      hosCompliancePercentile: 30,
      vehicleMaintPercentile: 19,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(4)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'NEEDS_REVIEW',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Sentry Insurance',
        policyNumber: 'SNT-AUTO-301924',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(60),
        expirationDate: getFutureDate(305),
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(5)
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Sentry Insurance',
        policyNumber: 'SNT-CARGO-301925',
        coverageLimit: 250000, // Limit is sufficient, BUT reefer endorsement is FALSE!
        effectiveDate: getPastDate(60),
        expirationDate: getFutureDate(305),
        reeferBreakdownEndorsement: false, // MISSING REEFER ENDORSEMENT
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(5)
      }
    ]
  },
  {
    dotNumber: '3409182',
    mcNumber: 'MC-1192831',
    legalName: 'Revoked Haulers LLC',
    dbaName: 'Revoked Express',
    contact: {
      phone: '(555) 777-1092',
      email: 'ops@revokedhaulers.com',
      address: { street: '900 Defunct Way', city: 'Phoenix', state: 'AZ', zip: '85001' }
    },
    authorityStatus: 'REVOKED', // REVOKED AUTHORITY
    authorityGrantDate: getPastDate(500),
    safetyRating: 'UNSATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 88,
      hosCompliancePercentile: 91,
      vehicleMaintPercentile: 79,
      crashTotal: 4,
      lastFmcsaCheck: getPastDate(1)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'FAIL',
    insurancePolicies: []
  },
  {
    dotNumber: '3892019',
    mcNumber: 'MC-1204910',
    legalName: 'Pending Verification Express Inc',
    dbaName: 'Pending Express',
    contact: {
      phone: '(555) 881-2091',
      email: 'dispatch@pendingexpress.com',
      address: { street: '300 Gateway Blvd', city: 'Atlanta', state: 'GA', zip: '30301' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(180),
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 15,
      hosCompliancePercentile: 20,
      vehicleMaintPercentile: 18,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(2)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'NEEDS_REVIEW',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Berkshire Hathaway GUARD',
        policyNumber: 'BH-AUTO-50192',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(30),
        expirationDate: getFutureDate(335),
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(5)
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Berkshire Hathaway GUARD',
        policyNumber: 'BH-CARGO-50193',
        coverageLimit: 250000,
        effectiveDate: getPastDate(30),
        expirationDate: getFutureDate(335),
        reeferBreakdownEndorsement: true,
        verificationStatus: 'UNVERIFIED', // UNVERIFIED COI UPLOAD
        uploadedDocumentUri: '/uploads/coi/pending_express_coi_2026.pdf',
        notes: 'Document uploaded via carrier portal; pending compliance review.'
      }
    ]
  },
  {
    dotNumber: '2701928',
    mcNumber: 'MC-871920',
    legalName: 'Lapsed Logistics Corp',
    dbaName: 'Lapsed Trucking',
    contact: {
      phone: '(555) 902-1829',
      email: 'ops@lapsedlogistics.com',
      address: { street: '110 Lapsed Rd', city: 'Memphis', state: 'TN', zip: '38103' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(600),
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 25,
      hosCompliancePercentile: 35,
      vehicleMaintPercentile: 22,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(5)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'FAIL',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Canal Insurance',
        policyNumber: 'CNL-AUTO-109281',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(380),
        expirationDate: getPastDate(15), // EXPIRED 15 DAYS AGO
        verificationStatus: 'EXPIRED'
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Canal Insurance',
        policyNumber: 'CNL-CARGO-109282',
        coverageLimit: 250000,
        effectiveDate: getPastDate(380),
        expirationDate: getPastDate(15), // EXPIRED 15 DAYS AGO
        reeferBreakdownEndorsement: true,
        verificationStatus: 'EXPIRED'
      }
    ]
  },
  {
    dotNumber: '4019281',
    mcNumber: 'MC-1394019',
    legalName: 'Incomplete Trucking LLC',
    contact: {
      phone: '(555) 441-9021',
      email: 'info@incompletetrucking.com',
      address: { street: '202 Missing St', city: 'Omaha', state: 'NE', zip: '68102' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(100),
    safetyRating: 'NONE',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 10,
      hosCompliancePercentile: 12,
      vehicleMaintPercentile: 15,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(6)
    },
    fraudSignals: {
      domainMatchVerified: true,
      virtualOfficeDetected: false
    },
    isDemoData: true,
    overallStatus: 'UNKNOWN',
    insurancePolicies: [] // EMPTY INSURANCE POLICIES
  },
  {
    dotNumber: '3219401',
    mcNumber: 'MC-1083921',
    legalName: 'Suspicious Domain Transport LLC',
    contact: {
      phone: '(555) 661-8920',
      email: 'fastloads@gmail-carrier-dispatch.com', // Spoofed domain
      address: { street: '440 Virtual Blvd Ste 100', city: 'Miami', state: 'FL', zip: '33101' }
    },
    authorityStatus: 'ACTIVE',
    authorityGrantDate: getPastDate(250),
    safetyRating: 'SATISFACTORY',
    fmcsaMetrics: {
      unsafeDrivingPercentile: 30,
      hosCompliancePercentile: 32,
      vehicleMaintPercentile: 25,
      crashTotal: 0,
      lastFmcsaCheck: getPastDate(3)
    },
    fraudSignals: {
      domainMatchVerified: false, // CONFLICTING EVIDENCE
      virtualOfficeDetected: true
    },
    isDemoData: true,
    overallStatus: 'NEEDS_REVIEW',
    insurancePolicies: [
      {
        policyType: 'AUTO_LIABILITY',
        insuranceProvider: 'Liberty Mutual Commercial',
        policyNumber: 'LM-AUTO-401920',
        coverageLimit: 1000000,
        effectiveDate: getPastDate(90),
        expirationDate: getFutureDate(275),
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(10)
      },
      {
        policyType: 'CARGO',
        insuranceProvider: 'Liberty Mutual Commercial',
        policyNumber: 'LM-CARGO-401921',
        coverageLimit: 250000,
        effectiveDate: getPastDate(90),
        expirationDate: getFutureDate(275),
        reeferBreakdownEndorsement: true,
        verificationStatus: 'VERIFIED',
        verifiedBy: 'Compliance Officer Sarah',
        verifiedAt: getPastDate(10)
      }
    ]
  }
];

const DEMO_LOADS = [
  {
    loadNumber: 'LD-1029',
    shipperName: 'Fresh Valley Farms',
    origin: {
      city: 'Salinas',
      state: 'CA',
      pickupDate: getFutureDate(2)
    },
    destination: {
      city: 'Chicago',
      state: 'IL',
      deliveryDate: getFutureDate(5)
    },
    commodity: 'Fresh Organic Strawberries',
    equipmentType: 'REEFER',
    targetTemperature: 34, // 34 degrees F
    declaredCargoValue: 200000, // $200k high value
    loadRequirements: {
      minAuthorityAgeDays: 90,
      minAutoLiability: 1000000,
      requireReeferEndorsement: true,
      disallowConditionalSafety: true,
      maxUnsafeDrivingPercentile: 75
    },
    status: 'POSTED',
    isDemoData: true
  },
  {
    loadNumber: 'LD-1030',
    shipperName: 'Heartland Automotive Logistics',
    origin: {
      city: 'Columbus',
      state: 'OH',
      pickupDate: getFutureDate(3)
    },
    destination: {
      city: 'Atlanta',
      state: 'GA',
      deliveryDate: getFutureDate(4)
    },
    commodity: 'Packaged Automotive Components',
    equipmentType: 'DRY_VAN',
    declaredCargoValue: 80000, // $80k standard cargo
    loadRequirements: {
      minAuthorityAgeDays: 90,
      minAutoLiability: 1000000,
      requireReeferEndorsement: false,
      disallowConditionalSafety: true,
      maxUnsafeDrivingPercentile: 75
    },
    status: 'POSTED',
    isDemoData: true
  }
];

module.exports = {
  DEMO_CARRIERS,
  DEMO_LOADS
};
