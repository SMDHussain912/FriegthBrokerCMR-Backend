const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateCarrierForLoad,
  evaluateOperatingAuthority,
  evaluateAuthorityAge,
  evaluateSafetyRating,
  evaluateAutoLiability,
  evaluateCargoLiability,
  evaluateReeferEndorsement,
  evaluateStaleness,
  evaluateConflictingEvidence
} = require('../services/vettingEngine');

const FIXED_DATE = new Date('2026-10-20T12:00:00.000Z');

// Helper to construct baseline valid carrier
const createBaseCarrier = (overrides = {}) => ({
  _id: '67150a000000000000000001',
  dotNumber: '2849102',
  mcNumber: 'MC-981240',
  legalName: 'Apex Freight Logistics LLC',
  authorityStatus: 'ACTIVE',
  authorityGrantDate: new Date('2025-01-01T00:00:00.000Z'), // ~650 days active
  safetyRating: 'SATISFACTORY',
  fmcsaMetrics: {
    unsafeDrivingPercentile: 15,
    hosCompliancePercentile: 20,
    vehicleMaintPercentile: 10,
    crashTotal: 0,
    lastFmcsaCheck: new Date('2026-10-18T00:00:00.000Z') // 2 days ago
  },
  insurancePolicies: [
    {
      policyType: 'AUTO_LIABILITY',
      insuranceProvider: 'Travelers',
      policyNumber: 'TRV-AUTO-101',
      coverageLimit: 1000000,
      effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
      expirationDate: new Date('2027-01-01T00:00:00.000Z'),
      verificationStatus: 'VERIFIED',
      verifiedBy: 'Compliance Sarah',
      verifiedAt: new Date('2026-01-05T00:00:00.000Z')
    },
    {
      policyType: 'CARGO',
      insuranceProvider: 'Great West',
      policyNumber: 'GWC-CARGO-202',
      coverageLimit: 250000,
      effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
      expirationDate: new Date('2027-01-01T00:00:00.000Z'),
      reeferBreakdownEndorsement: true,
      verificationStatus: 'VERIFIED',
      verifiedBy: 'Compliance Sarah',
      verifiedAt: new Date('2026-01-05T00:00:00.000Z')
    }
  ],
  fraudSignals: {
    domainMatchVerified: true,
    virtualOfficeDetected: false
  },
  ...overrides
});

// Helper to construct baseline reefer load ($200k cargo value)
const createBaseLoad = (overrides = {}) => ({
  _id: '67150b000000000000000001',
  loadNumber: 'LD-1029',
  commodity: 'Organic Strawberries',
  equipmentType: 'REEFER',
  targetTemperature: 34,
  declaredCargoValue: 200000,
  loadRequirements: {
    minAuthorityAgeDays: 90,
    minAutoLiability: 1000000,
    requireReeferEndorsement: true,
    disallowConditionalSafety: true
  },
  ...overrides
});

describe('Deterministic Vetting Engine Unit Tests', () => {

  describe('1. Sufficient and Insufficient Cargo Insurance', () => {
    it('evaluates to PASS when verified cargo limit ($250k) exceeds declared cargo value ($200k)', () => {
      const carrier = createBaseCarrier();
      const load = createBaseLoad({ declaredCargoValue: 200000 });
      const result = evaluateCargoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'PASS');
      assert.equal(result.reasonCode, 'LIMIT_MET');
      assert.equal(result.actualValue, 250000);
      assert.equal(result.requiredValue, 200000);
      assert.ok(result.evidence.source.includes('Great West'));
    });

    it('evaluates to FAIL when cargo limit ($100k) is less than declared cargo value ($200k)', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'CARGO',
            insuranceProvider: 'Nationwide',
            policyNumber: 'NW-CARGO-99',
            coverageLimit: 100000,
            effectiveDate: new Date('2026-01-01'),
            expirationDate: new Date('2027-01-01'),
            verificationStatus: 'VERIFIED'
          }
        ]
      });
      const load = createBaseLoad({ declaredCargoValue: 200000 });
      const result = evaluateCargoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'INSUFFICIENT_LIMIT');
      assert.equal(result.actualValue, 100000);
      assert.equal(result.requiredValue, 200000);
      assert.ok(result.notes.includes('fails declared cargo value'));
    });
  });

  describe('2. Missing Data Handling (Never Silently Passes)', () => {
    it('evaluates to UNKNOWN when carrier has no cargo policy on file', () => {
      const carrier = createBaseCarrier({ insurancePolicies: [] });
      const load = createBaseLoad();
      const result = evaluateCargoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.reasonCode, 'MISSING_CARGO_POLICY');
      assert.equal(result.actualValue, null);
    });

    it('evaluates to UNKNOWN when operating authority status is missing or undefined', () => {
      const carrier = createBaseCarrier({ authorityStatus: null });
      const result = evaluateOperatingAuthority(carrier, FIXED_DATE);

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.reasonCode, 'MISSING_AUTHORITY_STATUS');
    });

    it('evaluates to UNKNOWN when authority grant date is missing', () => {
      const carrier = createBaseCarrier({ authorityGrantDate: null });
      const load = createBaseLoad();
      const result = evaluateAuthorityAge(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.reasonCode, 'MISSING_GRANT_DATE');
    });

    it('sets overallStatus to UNKNOWN when any essential rule has missing evidence', () => {
      const carrier = createBaseCarrier({ insurancePolicies: [] });
      const load = createBaseLoad();
      const fullEvaluation = evaluateCarrierForLoad(carrier, load, FIXED_DATE);

      assert.equal(fullEvaluation.overallStatus, 'UNKNOWN');
      assert.equal(fullEvaluation.isEligible, false);
      assert.ok(fullEvaluation.summary.unknownChecks > 0);
    });
  });

  describe('3. Expired Policies', () => {
    it('evaluates to FAIL when cargo policy expired in the past', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'CARGO',
            insuranceProvider: 'Canal',
            policyNumber: 'CNL-CARGO-001',
            coverageLimit: 250000,
            effectiveDate: new Date('2025-01-01'),
            expirationDate: new Date('2026-10-01'), // Expired 19 days before FIXED_DATE (Oct 20)
            verificationStatus: 'VERIFIED'
          }
        ]
      });
      const load = createBaseLoad();
      const result = evaluateCargoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'EXPIRED_POLICY');
      assert.ok(result.notes.includes('expired on'));
    });

    it('evaluates to FAIL when auto liability policy expired in the past', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'AUTO_LIABILITY',
            insuranceProvider: 'Canal',
            policyNumber: 'CNL-AUTO-001',
            coverageLimit: 1000000,
            effectiveDate: new Date('2025-01-01'),
            expirationDate: new Date('2026-10-15'), // Expired 5 days before FIXED_DATE
            verificationStatus: 'VERIFIED'
          }
        ]
      });
      const load = createBaseLoad();
      const result = evaluateAutoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'EXPIRED_POLICY');
    });
  });

  describe('4. Missing Reefer Endorsement on Refrigerated Freight', () => {
    it('evaluates to FAIL when carrier lacks reefer breakdown endorsement on a REEFER load', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'CARGO',
            insuranceProvider: 'Sentry',
            policyNumber: 'SNT-301',
            coverageLimit: 250000,
            effectiveDate: new Date('2026-01-01'),
            expirationDate: new Date('2027-01-01'),
            reeferBreakdownEndorsement: false, // Explicitly false!
            verificationStatus: 'VERIFIED'
          }
        ]
      });
      const load = createBaseLoad({ equipmentType: 'REEFER' });
      const result = evaluateReeferEndorsement(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'MISSING_REEFER_ENDORSEMENT');
      assert.equal(result.actualValue, false);
      assert.ok(result.notes.includes('excludes temperature damage'));
    });

    it('evaluates to PASS (NOT_APPLICABLE) when the load is DRY_VAN even without reefer endorsement', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'CARGO',
            coverageLimit: 250000,
            reeferBreakdownEndorsement: false,
            verificationStatus: 'VERIFIED'
          }
        ]
      });
      const load = createBaseLoad({
        equipmentType: 'DRY_VAN',
        loadRequirements: { requireReeferEndorsement: false }
      });
      const result = evaluateReeferEndorsement(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'PASS');
      assert.equal(result.reasonCode, 'NOT_APPLICABLE');
    });
  });

  describe('5. Revoked or Inactive Authority', () => {
    it('evaluates to FAIL when operating authority status is REVOKED', () => {
      const carrier = createBaseCarrier({ authorityStatus: 'REVOKED' });
      const result = evaluateOperatingAuthority(carrier, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'AUTHORITY_NOT_ACTIVE');
      assert.equal(result.actualValue, 'REVOKED');
      assert.ok(result.notes.includes('prohibited'));
    });

    it('evaluates to FAIL when operating authority status is INACTIVE', () => {
      const carrier = createBaseCarrier({ authorityStatus: 'INACTIVE' });
      const result = evaluateOperatingAuthority(carrier, FIXED_DATE);

      assert.equal(result.status, 'FAIL');
      assert.equal(result.reasonCode, 'AUTHORITY_NOT_ACTIVE');
    });

    it('evaluates to NEEDS_REVIEW when authority status is PENDING', () => {
      const carrier = createBaseCarrier({ authorityStatus: 'PENDING' });
      const result = evaluateOperatingAuthority(carrier, FIXED_DATE);

      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reasonCode, 'AUTHORITY_PENDING');
    });
  });

  describe('6. Conflicting Evidence Handling', () => {
    it('evaluates to NEEDS_REVIEW when carrier email domain does not match FMCSA registration', () => {
      const carrier = createBaseCarrier({
        fraudSignals: { domainMatchVerified: false, virtualOfficeDetected: false }
      });
      const result = evaluateConflictingEvidence(carrier, FIXED_DATE);

      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reasonCode, 'CONFLICTING_EVIDENCE_DOMAIN');
      assert.ok(result.notes.includes('Possible spoofing'));
    });

    it('evaluates to NEEDS_REVIEW when carrier address resolves to a virtual office', () => {
      const carrier = createBaseCarrier({
        fraudSignals: { domainMatchVerified: true, virtualOfficeDetected: true }
      });
      const result = evaluateConflictingEvidence(carrier, FIXED_DATE);

      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reasonCode, 'CONFLICTING_EVIDENCE_ADDRESS');
      assert.ok(result.notes.includes('virtual office'));
    });
  });

  describe('7. Stale and Unverified Evidence Handling', () => {
    it('evaluates to NEEDS_REVIEW when COI is uploaded but verificationStatus is UNVERIFIED', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [
          {
            policyType: 'CARGO',
            insuranceProvider: 'GUARD',
            policyNumber: 'G-501',
            coverageLimit: 250000,
            effectiveDate: new Date('2026-01-01'),
            expirationDate: new Date('2027-01-01'),
            reeferBreakdownEndorsement: true,
            verificationStatus: 'UNVERIFIED' // Recorded on PDF but unverified!
          }
        ]
      });
      const load = createBaseLoad();
      const result = evaluateCargoLiability(carrier, load, FIXED_DATE);

      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reasonCode, 'UNVERIFIED_DOCUMENT');
      assert.ok(result.notes.includes('not confirmed coverage'));
    });

    it('evaluates to NEEDS_REVIEW when FMCSA check date is older than 14-day staleness threshold', () => {
      const carrier = createBaseCarrier({
        fmcsaMetrics: {
          lastFmcsaCheck: new Date('2026-09-01T00:00:00.000Z') // ~49 days old (stale)
        }
      });
      const result = evaluateStaleness(carrier, FIXED_DATE);

      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reasonCode, 'STALE_EVIDENCE');
      assert.ok(result.notes.includes('threshold: 14 days'));
    });
  });

  describe('8. Overall Decision Precedence & Evidence Isolation', () => {
    it('produces overallStatus PASS and isEligible true only when all rules are satisfied', () => {
      const carrier = createBaseCarrier();
      const load = createBaseLoad();
      const result = evaluateCarrierForLoad(carrier, load, FIXED_DATE);

      assert.equal(result.overallStatus, 'PASS');
      assert.equal(result.isEligible, true);
      assert.equal(result.summary.failedChecks, 0);
      assert.equal(result.summary.unknownChecks, 0);
      assert.equal(result.summary.reviewChecks, 0);
      assert.equal(result.summary.passedChecks, 8);
    });

    it('ensures FAIL takes precedence over UNKNOWN and NEEDS_REVIEW', () => {
      const carrier = createBaseCarrier({
        authorityStatus: 'REVOKED', // FAIL
        authorityGrantDate: null,    // UNKNOWN
        fraudSignals: { domainMatchVerified: false } // NEEDS_REVIEW
      });
      const load = createBaseLoad();
      const result = evaluateCarrierForLoad(carrier, load, FIXED_DATE);

      assert.equal(result.overallStatus, 'FAIL');
      assert.equal(result.isEligible, false);
      assert.ok(result.summary.failedChecks > 0);
      assert.ok(result.summary.unknownChecks > 0);
      assert.ok(result.summary.reviewChecks > 0);
    });

    it('ensures UNKNOWN takes precedence over NEEDS_REVIEW when no FAIL is present', () => {
      const carrier = createBaseCarrier({
        insurancePolicies: [], // UNKNOWN
        fraudSignals: { domainMatchVerified: false } // NEEDS_REVIEW
      });
      const load = createBaseLoad();
      const result = evaluateCarrierForLoad(carrier, load, FIXED_DATE);

      assert.equal(result.overallStatus, 'UNKNOWN');
      assert.equal(result.isEligible, false);
    });

    it('ensures every evaluated check isolates decision from evidence payload', () => {
      const carrier = createBaseCarrier();
      const load = createBaseLoad();
      const result = evaluateCarrierForLoad(carrier, load, FIXED_DATE);

      result.checks.forEach(check => {
        assert.ok(check.ruleKey, 'Each check must have a ruleKey');
        assert.ok(check.status, 'Each check must have a status');
        assert.ok(check.evidence, 'Each check must have an evidence object');
        assert.ok(check.evidence.source, 'Evidence must record source');
        assert.ok(check.evidence.timestamp, 'Evidence must record timestamp');
      });
    });
  });

});
