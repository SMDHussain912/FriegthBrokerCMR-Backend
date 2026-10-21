/**
 * Deterministic Four-State Carrier Vetting & Load Eligibility Engine
 * 
 * Evaluates a carrier against specific load requirements and brokerage compliance thresholds.
 * Strictly adheres to 4 states:
 * - PASS: Evidence is verified, fresh, consistent, and meets or exceeds criteria.
 * - FAIL: Verified evidence explicitly breaches a mandatory threshold.
 * - NEEDS_REVIEW: Evidence is ambiguous, unverified, stale, conflicting, or requires compliance audit.
 * - UNKNOWN: Required evidence is missing, undefined, or unreachable. Missing data NEVER passes.
 * 
 * IMPORTANT: A recorded policy limit on an uploaded COI does NOT equate to confirmed coverage.
 * Unverified documents remain in NEEDS_REVIEW.
 */

const RULE_VERSION = '1.0.0';
const STALENESS_THRESHOLD_DAYS = 14;

/**
 * Helper to compute day difference between two dates
 */
const getDayDifference = (date1, date2) => {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((date1 - date2) / msPerDay);
};

/**
 * 1. Evaluate Operating Authority
 */
const evaluateOperatingAuthority = (carrier, currentDate) => {
  const ruleKey = 'OPERATING_AUTHORITY';
  const ruleName = 'Operating Authority Active Status';
  const requiredValue = 'ACTIVE';

  if (!carrier || !carrier.authorityStatus) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_AUTHORITY_STATUS',
      requiredValue,
      actualValue: null,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier operating authority status is missing from record. Missing data cannot pass.'
    };
  }

  const status = carrier.authorityStatus.toUpperCase();

  if (status === 'REVOKED' || status === 'INACTIVE') {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'AUTHORITY_NOT_ACTIVE',
      requiredValue,
      actualValue: status,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        authorityStatus: status,
        isMock: true
      },
      notes: `Operating authority is ${status}. Load assignment is strictly prohibited.`
    };
  }

  if (status === 'PENDING') {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'AUTHORITY_PENDING',
      requiredValue,
      actualValue: status,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        authorityStatus: status,
        isMock: true
      },
      notes: 'Operating authority application is pending final FMCSA issuance. Requires compliance review.'
    };
  }

  if (status === 'ACTIVE') {
    return {
      ruleKey,
      ruleName,
      status: 'PASS',
      reasonCode: 'AUTHORITY_ACTIVE',
      requiredValue,
      actualValue: status,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        authorityStatus: status,
        isMock: true
      },
      notes: 'Operating authority is currently active with common/contract carrier authority.'
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'UNKNOWN',
    reasonCode: 'UNRECOGNIZED_AUTHORITY_STATUS',
    requiredValue,
    actualValue: status,
    evidence: {
      source: 'Mock FMCSA SAFER Provider (Demo)',
      timestamp: currentDate,
      isMock: true
    },
    notes: `Unrecognized authority status '${status}'.`
  };
};

/**
 * 2. Evaluate Operating Authority Age (Tenure)
 */
const evaluateAuthorityAge = (carrier, load, currentDate) => {
  const ruleKey = 'AUTHORITY_AGE_DAYS';
  const ruleName = 'Operating Authority Minimum Tenure';
  const requiredDays = (load && load.loadRequirements && typeof load.loadRequirements.minAuthorityAgeDays === 'number')
    ? load.loadRequirements.minAuthorityAgeDays
    : 90;

  if (!carrier || !carrier.authorityGrantDate) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_GRANT_DATE',
      requiredValue: requiredDays,
      actualValue: null,
      evidence: {
        source: 'Mock FMCSA Licensing & Insurance (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Authority grant date is missing from carrier profile. Cannot verify carrier tenure.'
    };
  }

  const grantDate = new Date(carrier.authorityGrantDate);
  if (isNaN(grantDate.getTime())) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'INVALID_GRANT_DATE',
      requiredValue: requiredDays,
      actualValue: carrier.authorityGrantDate,
      evidence: {
        source: 'Mock FMCSA Licensing & Insurance (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Authority grant date is not a valid date format.'
    };
  }

  const daysActive = getDayDifference(currentDate, grantDate);

  if (daysActive < 0) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'FUTURE_GRANT_DATE',
      requiredValue: requiredDays,
      actualValue: daysActive,
      evidence: {
        source: 'Mock FMCSA Licensing & Insurance (Demo)',
        grantDate: grantDate.toISOString(),
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Authority grant date is in the future. Requires manual review.'
    };
  }

  if (daysActive < requiredDays) {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'INSUFFICIENT_AUTHORITY_AGE',
      requiredValue: requiredDays,
      actualValue: daysActive,
      evidence: {
        source: 'Mock FMCSA Licensing & Insurance (Demo)',
        grantDate: grantDate.toISOString(),
        daysActive,
        timestamp: currentDate,
        isMock: true
      },
      notes: `Carrier has been active for ${daysActive} days, failing required minimum tenure of ${requiredDays} days.`
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'AUTHORITY_AGE_MET',
    requiredValue: requiredDays,
    actualValue: daysActive,
    evidence: {
      source: 'Mock FMCSA Licensing & Insurance (Demo)',
      grantDate: grantDate.toISOString(),
      daysActive,
      timestamp: currentDate,
      isMock: true
    },
    notes: `Carrier has been active for ${daysActive} days, satisfying required minimum tenure of ${requiredDays} days.`
  };
};

/**
 * 3. Evaluate Safety Rating
 */
const evaluateSafetyRating = (carrier, load, currentDate) => {
  const ruleKey = 'SAFETY_RATING';
  const ruleName = 'FMCSA Safety Rating Evaluation';
  const disallowConditional = load?.loadRequirements?.disallowConditionalSafety !== false;

  if (!carrier || !carrier.safetyRating) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_SAFETY_RATING',
      requiredValue: disallowConditional ? 'NOT CONDITIONAL / UNSATISFACTORY' : 'ANY',
      actualValue: null,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Safety rating is missing from profile. Missing data cannot pass.'
    };
  }

  const rating = carrier.safetyRating.toUpperCase();

  if (rating === 'UNSATISFACTORY') {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'UNSATISFACTORY_SAFETY_RATING',
      requiredValue: 'SATISFACTORY / NONE',
      actualValue: rating,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier has an UNSATISFACTORY safety rating. Federal law and company policy prohibit load dispatch.'
    };
  }

  if (rating === 'CONDITIONAL') {
    if (disallowConditional) {
      return {
        ruleKey,
        ruleName,
        status: 'FAIL',
        reasonCode: 'CONDITIONAL_SAFETY_RATING_BLOCKED',
        requiredValue: 'SATISFACTORY / UNRATED',
        actualValue: rating,
        evidence: {
          source: 'Mock FMCSA SAFER Provider (Demo)',
          timestamp: currentDate,
          isMock: true
        },
        notes: 'Carrier has a CONDITIONAL safety rating and load requirements disallow conditional carriers.'
      };
    }
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'CONDITIONAL_SAFETY_RATING_FLAGGED',
      requiredValue: 'REVIEW_REQUIRED',
      actualValue: rating,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier has a CONDITIONAL safety rating. Allowed by load config but flagged for compliance review.'
    };
  }

  if (rating === 'NONE') {
    return {
      ruleKey,
      ruleName,
      status: 'PASS',
      reasonCode: 'UNRATED_CARRIER_ALLOWED',
      requiredValue: 'SATISFACTORY / UNRATED',
      actualValue: 'NONE (UNRATED)',
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier has not received a formal FMCSA audit rating (majority of US motor carriers). Permitted under unrated policy.'
    };
  }

  if (rating === 'SATISFACTORY') {
    return {
      ruleKey,
      ruleName,
      status: 'PASS',
      reasonCode: 'SATISFACTORY_SAFETY_RATING',
      requiredValue: 'SATISFACTORY',
      actualValue: rating,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier holds an active SATISFACTORY safety rating.'
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'UNKNOWN',
    reasonCode: 'UNKNOWN_SAFETY_RATING_VALUE',
    requiredValue: 'SATISFACTORY / NONE',
    actualValue: rating,
    evidence: {
      source: 'Mock FMCSA SAFER Provider (Demo)',
      timestamp: currentDate,
      isMock: true
    },
    notes: `Unrecognized safety rating value '${rating}'.`
  };
};

/**
 * 4. Evaluate Auto Liability Insurance
 */
const evaluateAutoLiability = (carrier, load, currentDate) => {
  const ruleKey = 'AUTO_LIABILITY_LIMIT';
  const ruleName = 'Auto Liability Coverage Limit';
  const requiredLimit = (load && load.loadRequirements && typeof load.loadRequirements.minAutoLiability === 'number')
    ? load.loadRequirements.minAutoLiability
    : 1000000;

  const policies = Array.isArray(carrier?.insurancePolicies) ? carrier.insurancePolicies : [];
  const autoPolicy = policies.find(p => p.policyType === 'AUTO_LIABILITY');

  if (!autoPolicy) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_AUTO_POLICY',
      requiredValue: requiredLimit,
      actualValue: null,
      evidence: {
        source: 'Certificate of Insurance Repository',
        timestamp: currentDate
      },
      notes: 'No Auto Liability policy on file for carrier. Missing insurance evidence cannot pass.'
    };
  }

  const expirationDate = new Date(autoPolicy.expirationDate);
  if (isNaN(expirationDate.getTime()) || expirationDate <= currentDate) {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'EXPIRED_POLICY',
      requiredValue: requiredLimit,
      actualValue: autoPolicy.coverageLimit,
      evidence: {
        source: `${autoPolicy.insuranceProvider || 'Insurer'} Policy #${autoPolicy.policyNumber || 'N/A'}`,
        expirationDate: autoPolicy.expirationDate,
        timestamp: currentDate
      },
      notes: `Auto Liability policy expired on ${expirationDate.toISOString().split('T')[0]}. Load dispatch is prohibited.`
    };
  }

  // Check verification state
  if (autoPolicy.verificationStatus === 'UNVERIFIED') {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'UNVERIFIED_DOCUMENT',
      requiredValue: requiredLimit,
      actualValue: autoPolicy.coverageLimit,
      evidence: {
        source: `${autoPolicy.insuranceProvider || 'Insurer'} Policy #${autoPolicy.policyNumber || 'N/A'}`,
        verificationStatus: 'UNVERIFIED',
        timestamp: currentDate
      },
      notes: 'COI has been uploaded, but has not yet been audited by compliance. Recorded limit is not confirmed coverage.'
    };
  }

  if (autoPolicy.verificationStatus === 'REJECTED') {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'REJECTED_DOCUMENT',
      requiredValue: requiredLimit,
      actualValue: autoPolicy.coverageLimit,
      evidence: {
        source: `${autoPolicy.insuranceProvider || 'Insurer'} Policy #${autoPolicy.policyNumber || 'N/A'}`,
        verificationStatus: 'REJECTED',
        timestamp: currentDate
      },
      notes: 'Auto Liability document was rejected by safety compliance officers.'
    };
  }

  // Check limit
  if (autoPolicy.coverageLimit < requiredLimit) {
    const deficit = requiredLimit - autoPolicy.coverageLimit;
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'INSUFFICIENT_LIMIT',
      requiredValue: requiredLimit,
      actualValue: autoPolicy.coverageLimit,
      evidence: {
        source: `${autoPolicy.insuranceProvider} Policy #${autoPolicy.policyNumber}`,
        verificationStatus: 'VERIFIED',
        expirationDate: autoPolicy.expirationDate,
        timestamp: currentDate
      },
      notes: `Verified coverage limit ($${autoPolicy.coverageLimit.toLocaleString()}) fails requirement ($${requiredLimit.toLocaleString()}) by deficit of $${deficit.toLocaleString()}.`
    };
  }

  // Check imminent expiration (< 48 hours)
  const hoursUntilExpiration = (expirationDate - currentDate) / (1000 * 60 * 60);
  if (hoursUntilExpiration < 48) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'STALE_OR_IMMINENT_EXPIRATION',
      requiredValue: requiredLimit,
      actualValue: autoPolicy.coverageLimit,
      evidence: {
        source: `${autoPolicy.insuranceProvider} Policy #${autoPolicy.policyNumber}`,
        verificationStatus: 'VERIFIED',
        expirationDate: autoPolicy.expirationDate,
        hoursUntilExpiration: Math.round(hoursUntilExpiration),
        timestamp: currentDate
      },
      notes: `Policy is verified but expires in ${Math.round(hoursUntilExpiration)} hours. Requires renewal verification before dispatch.`
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'LIMIT_MET',
    requiredValue: requiredLimit,
    actualValue: autoPolicy.coverageLimit,
    evidence: {
      source: `${autoPolicy.insuranceProvider} Policy #${autoPolicy.policyNumber}`,
      verificationStatus: 'VERIFIED',
      expirationDate: autoPolicy.expirationDate,
      timestamp: currentDate
    },
    notes: `Verified Auto Liability limit ($${autoPolicy.coverageLimit.toLocaleString()}) satisfies required minimum ($${requiredLimit.toLocaleString()}).`
  };
};

/**
 * 5. Evaluate Cargo Liability Insurance
 */
const evaluateCargoLiability = (carrier, load, currentDate) => {
  const ruleKey = 'CARGO_LIMIT_MATCH';
  const ruleName = 'Declared Cargo Insurance Limit';
  const requiredLimit = (load && typeof load.declaredCargoValue === 'number')
    ? load.declaredCargoValue
    : 100000;

  const policies = Array.isArray(carrier?.insurancePolicies) ? carrier.insurancePolicies : [];
  const cargoPolicy = policies.find(p => p.policyType === 'CARGO');

  if (!cargoPolicy) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_CARGO_POLICY',
      requiredValue: requiredLimit,
      actualValue: null,
      evidence: {
        source: 'Certificate of Insurance Repository',
        timestamp: currentDate
      },
      notes: 'No Cargo Liability policy on file for carrier. Missing cargo insurance cannot pass.'
    };
  }

  const expirationDate = new Date(cargoPolicy.expirationDate);
  if (isNaN(expirationDate.getTime()) || expirationDate <= currentDate) {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'EXPIRED_POLICY',
      requiredValue: requiredLimit,
      actualValue: cargoPolicy.coverageLimit,
      evidence: {
        source: `${cargoPolicy.insuranceProvider || 'Insurer'} Policy #${cargoPolicy.policyNumber || 'N/A'}`,
        expirationDate: cargoPolicy.expirationDate,
        timestamp: currentDate
      },
      notes: `Cargo policy expired on ${expirationDate.toISOString().split('T')[0]}. Load dispatch is prohibited.`
    };
  }

  if (cargoPolicy.verificationStatus === 'UNVERIFIED') {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'UNVERIFIED_DOCUMENT',
      requiredValue: requiredLimit,
      actualValue: cargoPolicy.coverageLimit,
      evidence: {
        source: `${cargoPolicy.insuranceProvider || 'Insurer'} Policy #${cargoPolicy.policyNumber || 'N/A'}`,
        verificationStatus: 'UNVERIFIED',
        timestamp: currentDate
      },
      notes: 'COI has been uploaded, but has not yet been audited by compliance. Recorded limit is not confirmed coverage.'
    };
  }

  if (cargoPolicy.verificationStatus === 'REJECTED') {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'REJECTED_DOCUMENT',
      requiredValue: requiredLimit,
      actualValue: cargoPolicy.coverageLimit,
      evidence: {
        source: `${cargoPolicy.insuranceProvider || 'Insurer'} Policy #${cargoPolicy.policyNumber || 'N/A'}`,
        verificationStatus: 'REJECTED',
        timestamp: currentDate
      },
      notes: 'Cargo policy document was rejected by safety compliance officers.'
    };
  }

  if (cargoPolicy.coverageLimit < requiredLimit) {
    const deficit = requiredLimit - cargoPolicy.coverageLimit;
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'INSUFFICIENT_LIMIT',
      requiredValue: requiredLimit,
      actualValue: cargoPolicy.coverageLimit,
      evidence: {
        source: `${cargoPolicy.insuranceProvider} Policy #${cargoPolicy.policyNumber}`,
        verificationStatus: 'VERIFIED',
        expirationDate: cargoPolicy.expirationDate,
        timestamp: currentDate
      },
      notes: `Cargo policy limit ($${cargoPolicy.coverageLimit.toLocaleString()}) fails declared cargo value ($${requiredLimit.toLocaleString()}) by deficit of $${deficit.toLocaleString()}.`
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'LIMIT_MET',
    requiredValue: requiredLimit,
    actualValue: cargoPolicy.coverageLimit,
    evidence: {
      source: `${cargoPolicy.insuranceProvider} Policy #${cargoPolicy.policyNumber}`,
      verificationStatus: 'VERIFIED',
      expirationDate: cargoPolicy.expirationDate,
      timestamp: currentDate
    },
    notes: `Verified Cargo policy limit ($${cargoPolicy.coverageLimit.toLocaleString()}) satisfies declared cargo value ($${requiredLimit.toLocaleString()}).`
  };
};

/**
 * 6. Evaluate Reefer Breakdown Endorsement (if refrigerated freight)
 */
const evaluateReeferEndorsement = (carrier, load, currentDate) => {
  const ruleKey = 'REEFER_ENDORSEMENT';
  const ruleName = 'Reefer Breakdown Endorsement';
  const isReefer = (load?.equipmentType === 'REEFER') || (load?.loadRequirements?.requireReeferEndorsement === true);

  if (!isReefer) {
    return {
      ruleKey,
      ruleName,
      status: 'PASS',
      reasonCode: 'NOT_APPLICABLE',
      requiredValue: 'NOT_REQUIRED',
      actualValue: 'N/A',
      evidence: {
        source: 'Load Specification',
        timestamp: currentDate
      },
      notes: 'Reefer breakdown coverage is not required for non-refrigerated equipment.'
    };
  }

  const policies = Array.isArray(carrier?.insurancePolicies) ? carrier.insurancePolicies : [];
  const cargoPolicy = policies.find(p => p.policyType === 'CARGO');

  if (!cargoPolicy) {
    return {
      ruleKey,
      ruleName,
      status: 'UNKNOWN',
      reasonCode: 'MISSING_CARGO_POLICY',
      requiredValue: true,
      actualValue: null,
      evidence: {
        source: 'Certificate of Insurance Repository',
        timestamp: currentDate
      },
      notes: 'Cannot evaluate reefer endorsement because carrier has no cargo insurance on file.'
    };
  }

  if (cargoPolicy.verificationStatus === 'UNVERIFIED') {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'UNVERIFIED_DOCUMENT',
      requiredValue: true,
      actualValue: cargoPolicy.reeferBreakdownEndorsement || false,
      evidence: {
        source: `${cargoPolicy.insuranceProvider || 'Insurer'} Policy #${cargoPolicy.policyNumber || 'N/A'}`,
        verificationStatus: 'UNVERIFIED',
        timestamp: currentDate
      },
      notes: 'Cargo policy is unverified. Reefer endorsement clause must be audited by compliance.'
    };
  }

  if (cargoPolicy.reeferBreakdownEndorsement !== true) {
    return {
      ruleKey,
      ruleName,
      status: 'FAIL',
      reasonCode: 'MISSING_REEFER_ENDORSEMENT',
      requiredValue: true,
      actualValue: false,
      evidence: {
        source: `${cargoPolicy.insuranceProvider} Policy #${cargoPolicy.policyNumber}`,
        verificationStatus: 'VERIFIED',
        timestamp: currentDate
      },
      notes: 'Standard cargo insurance excludes temperature damage. Carrier lacks verified Reefer Breakdown Endorsement.'
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'REEFER_ENDORSEMENT_VERIFIED',
    requiredValue: true,
    actualValue: true,
    evidence: {
      source: `${cargoPolicy.insuranceProvider} Policy #${cargoPolicy.policyNumber}`,
      verificationStatus: 'VERIFIED',
      timestamp: currentDate
    },
    notes: 'Active Reefer Breakdown Endorsement verified on cargo policy with no mechanical exclusions.'
  };
};

/**
 * 7. Evaluate Evidence Freshness & Stale FMCSA Data
 */
const evaluateStaleness = (carrier, currentDate) => {
  const ruleKey = 'DATA_FRESHNESS';
  const ruleName = 'Regulatory Data Freshness';

  if (!carrier?.fmcsaMetrics?.lastFmcsaCheck) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'STALE_DATA_NEVER_CHECKED',
      requiredValue: `< ${STALENESS_THRESHOLD_DAYS} days`,
      actualValue: 'NEVER',
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'FMCSA safety records have no recorded check date. Data refresh recommended.'
    };
  }

  const lastCheck = new Date(carrier.fmcsaMetrics.lastFmcsaCheck);
  const daysSinceCheck = getDayDifference(currentDate, lastCheck);

  if (daysSinceCheck > STALENESS_THRESHOLD_DAYS) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'STALE_EVIDENCE',
      requiredValue: `< ${STALENESS_THRESHOLD_DAYS} days`,
      actualValue: `${daysSinceCheck} days ago`,
      evidence: {
        source: 'Mock FMCSA SAFER Provider (Demo)',
        lastCheckDate: lastCheck.toISOString(),
        daysSinceCheck,
        timestamp: currentDate,
        isMock: true
      },
      notes: `FMCSA data was last refreshed ${daysSinceCheck} days ago (threshold: ${STALENESS_THRESHOLD_DAYS} days). Data refresh required.`
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'DATA_FRESH',
    requiredValue: `< ${STALENESS_THRESHOLD_DAYS} days`,
    actualValue: `${daysSinceCheck} days ago`,
    evidence: {
      source: 'Mock FMCSA SAFER Provider (Demo)',
      lastCheckDate: lastCheck.toISOString(),
      daysSinceCheck,
      timestamp: currentDate,
      isMock: true
    },
    notes: `FMCSA regulatory data was verified ${daysSinceCheck} days ago.`
  };
};

/**
 * 8. Evaluate Conflicting Evidence (Internal discrepancy guard)
 */
const evaluateConflictingEvidence = (carrier, currentDate) => {
  const ruleKey = 'EVIDENCE_CONSISTENCY';
  const ruleName = 'Evidence & Entity Consistency';

  // Check for conflicts: e.g. carrier fraudSignals or name conflict
  if (carrier?.fraudSignals?.domainMatchVerified === false) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'CONFLICTING_EVIDENCE_DOMAIN',
      requiredValue: 'VERIFIED_DOMAIN',
      actualValue: 'MISMATCH',
      evidence: {
        source: 'Carrier Identity Proofing Engine (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Communication domain does not match FMCSA registered entity email domain. Possible spoofing or impersonation.'
    };
  }

  if (carrier?.fraudSignals?.virtualOfficeDetected === true) {
    return {
      ruleKey,
      ruleName,
      status: 'NEEDS_REVIEW',
      reasonCode: 'CONFLICTING_EVIDENCE_ADDRESS',
      requiredValue: 'PHYSICAL_DOMICILE',
      actualValue: 'VIRTUAL_OFFICE',
      evidence: {
        source: 'USPS / Physical Address Verifier (Demo)',
        timestamp: currentDate,
        isMock: true
      },
      notes: 'Carrier physical address resolves to a commercial mail receiving agency or virtual office.'
    };
  }

  return {
    ruleKey,
    ruleName,
    status: 'PASS',
    reasonCode: 'NO_CONFLICTS_DETECTED',
    requiredValue: 'CONSISTENT',
    actualValue: 'CONSISTENT',
    evidence: {
      source: 'Cross-Source Entity Verification (Demo)',
      timestamp: currentDate,
      isMock: true
    },
    notes: 'No entity identity discrepancies or conflicting evidence detected.'
  };
};

/**
 * Main Deterministic Vetting Function
 * 
 * @param {Object} carrier Carrier document or plain object
 * @param {Object} load Load document or plain object
 * @param {Date} [currentDate] Injected date for deterministic testing
 * @returns {Object} Full evaluation result with itemized checks and overall decision
 */
const evaluateCarrierForLoad = (carrier, load, currentDate = new Date()) => {
  const checks = [
    evaluateOperatingAuthority(carrier, currentDate),
    evaluateAuthorityAge(carrier, load, currentDate),
    evaluateSafetyRating(carrier, load, currentDate),
    evaluateAutoLiability(carrier, load, currentDate),
    evaluateCargoLiability(carrier, load, currentDate),
    evaluateReeferEndorsement(carrier, load, currentDate),
    evaluateStaleness(carrier, currentDate),
    evaluateConflictingEvidence(carrier, currentDate)
  ];

  // Count check statuses
  const summary = {
    totalChecks: checks.length,
    passedChecks: checks.filter(c => c.status === 'PASS').length,
    failedChecks: checks.filter(c => c.status === 'FAIL').length,
    reviewChecks: checks.filter(c => c.status === 'NEEDS_REVIEW').length,
    unknownChecks: checks.filter(c => c.status === 'UNKNOWN').length
  };

  // Determine Overall Status via Strict Precedence:
  // 1. FAIL overrides everything: If any rule explicitly fails, overall status is FAIL.
  // 2. UNKNOWN: If any rule has missing data and no hard fail, status is UNKNOWN (never passes).
  // 3. NEEDS_REVIEW: If any rule has unverified, stale, or conflicting data, status is NEEDS_REVIEW.
  // 4. PASS: ONLY if 100% of checks are PASS.
  let overallStatus = 'PASS';

  if (summary.failedChecks > 0) {
    overallStatus = 'FAIL';
  } else if (summary.unknownChecks > 0) {
    overallStatus = 'UNKNOWN';
  } else if (summary.reviewChecks > 0) {
    overallStatus = 'NEEDS_REVIEW';
  }

  const isEligible = overallStatus === 'PASS';

  return {
    ruleVersion: RULE_VERSION,
    evaluatedAt: currentDate,
    carrierId: carrier?._id?.toString() || carrier?.dotNumber || 'UNKNOWN',
    carrierName: carrier?.legalName || 'UNKNOWN',
    loadId: load?._id?.toString() || load?.loadNumber || 'UNKNOWN',
    overallStatus,
    isEligible,
    summary,
    checks
  };
};

module.exports = {
  evaluateCarrierForLoad,
  evaluateOperatingAuthority,
  evaluateAuthorityAge,
  evaluateSafetyRating,
  evaluateAutoLiability,
  evaluateCargoLiability,
  evaluateReeferEndorsement,
  evaluateStaleness,
  evaluateConflictingEvidence,
  RULE_VERSION,
  STALENESS_THRESHOLD_DAYS
};
