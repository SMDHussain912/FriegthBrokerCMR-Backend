/**
 * Company Status Middleware
 * 
 * Centralized enforcement of company status checks.
 * Prevents suspended companies from performing operational actions.
 */

const ALLOWED_STATUSES_FOR_OPERATIONS = ['active', 'verified'];
const READ_ONLY_STATUSES = ['pending', 'suspended'];

/**
 * Check if a company can perform operational actions
 * @param {Object} company - Company object
 * @returns {boolean}
 */
function canPerformOperations(company) {
  if (!company) return false;
  return ALLOWED_STATUSES_FOR_OPERATIONS.includes(company.status);
}

/**
 * Check if a company is in read-only mode
 * @param {Object} company - Company object
 * @returns {boolean}
 */
function isReadOnly(company) {
  if (!company) return true;
  return READ_ONLY_STATUSES.includes(company.status);
}

/**
 * Middleware to enforce company status for operational endpoints
 * Allows read-only operations for all statuses, blocks write operations for non-active companies
 * 
 * @param {Object} options - Options
 * @param {string[]} options.allowedReadActions - Actions allowed for all statuses
 * @param {boolean} options.allowVerified - Allow verified companies (default: true)
 */
function enforceCompanyStatus(options = {}) {
  const { 
    allowedReadActions = [
      'VIEW_LOADS', 'VIEW_CARRIER', 'VIEW_CUSTOMER', 'VIEW_INVOICE', 
      'VIEW_PAYABLE', 'VIEW_EXPENSE', 'VIEW_COMPLIANCE_REVIEW',
      'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'VIEW_JOB',
      'VIEW_COMPANY', 'VIEW_AUDIT_LOG', 'VIEW_SETTINGS',
      'VIEW_LOAD_DOCUMENTS', 'VIEW_CARRIER_DOCUMENTS',
      'VIEW_CARRIER_COMPLIANCE', 'VIEW_COMPLIANCE_REVIEW',
      'VIEW_INVOICE', 'VIEW_PAYABLE', 'VIEW_EXPENSE',
      'VIEW_FINANCIAL_REPORTS', 'VIEW_CUSTOMER', 'VIEW_LEAD',
      'VIEW_OPPORTUNITY', 'VIEW_QUOTE', 'VIEW_RATE_AGREEMENT',
      'VIEW_CONTACT', 'VIEW_LEAD', 'VIEW_OPPORTUNITY',
      'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
      'VIEW_LOADS', 'VIEW_LOAD_DOCUMENTS'
    ],
    allowVerified = true
  } = options;

  return (req, res, next) => {
    // Skip if no company context
    if (!req.company) {
      return next();
    }

    const companyStatus = req.company.status;
    const isReadAction = req.membership && req.membership.role && 
      allowedReadActions.includes(req.action || '');

    // Check if this is a read-only action
    const method = req.method;
    const isReadMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    
    // Get the action being performed (from middleware or route)
    const action = req.action || (req.route?.stack?.[0]?.method?.toUpperCase()) || method;

    // Allow read operations for all statuses
    if (isReadMethod || allowedReadActions.includes(action)) {
      return next();
    }

    // For write operations, check company status
    const canOperate = allowVerified 
      ? ALLOWED_STATUSES_FOR_OPERATIONS.includes(companyStatus)
      : companyStatus === 'active';

    if (!canOperate) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: Company status '${companyStatus}' does not allow this operation. Only active/verified companies can perform write operations.`,
        code: 'COMPANY_STATUS_FORBIDDEN',
        companyStatus: companyStatus
      });
    }

    return next();
  };
}

/**
 * Get allowed actions for a company status
 * @param {string} status - Company status
 * @returns {string[]} Allowed actions
 */
function getAllowedActionsForStatus(status) {
  const readActions = [
    'VIEW_LOADS', 'VIEW_CARRIER', 'VIEW_CUSTOMER', 'VIEW_INVOICE', 
    'VIEW_PAYABLE', 'VIEW_EXPENSE', 'VIEW_COMPLIANCE_REVIEW',
    'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'VIEW_JOB',
    'VIEW_COMPANY', 'VIEW_AUDIT_LOG', 'VIEW_SETTINGS',
    'VIEW_LOAD_DOCUMENTS', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_CARRIER_COMPLIANCE', 'VIEW_COMPLIANCE_REVIEW',
    'VIEW_INVOICE', 'VIEW_PAYABLE', 'VIEW_EXPENSE',
    'VIEW_FINANCIAL_REPORTS', 'VIEW_CUSTOMER', 'VIEW_LEAD',
    'VIEW_OPPORTUNITY', 'VIEW_QUOTE', 'VIEW_RATE_AGREEMENT',
    'VIEW_CONTACT', 'VIEW_LEAD', 'VIEW_OPPORTUNITY',
    'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_LOADS', 'VIEW_LOAD_DOCUMENTS'
  ];

  if (status === 'active' || status === 'verified') {
    return [
      ...readActions,
      'CREATE_LOAD', 'EDIT_LOAD', 'ASSIGN_LOAD', 'DELETE_LOAD',
      'CREATE_CARRIER', 'EDIT_CARRIER', 'ASSIGN_CARRIER',
      'CREATE_CUSTOMER', 'EDIT_CUSTOMER', 'DELETE_CUSTOMER',
      'CREATE_LEAD', 'EDIT_LEAD', 'DELETE_LEAD',
      'CREATE_OPPORTUNITY', 'EDIT_OPPORTUNITY', 'DELETE_OPPORTUNITY',
      'CREATE_QUOTE', 'EDIT_QUOTE', 'DELETE_QUOTE',
      'CREATE_RATE_AGREEMENT', 'EDIT_RATE_AGREEMENT', 'DELETE_RATE_AGREEMENT',
      'CREATE_CONTACT', 'EDIT_CONTACT', 'DELETE_CONTACT',
      'CREATE_INVOICE', 'EDIT_INVOICE', 'DELETE_INVOICE',
      'CREATE_PAYABLE', 'EDIT_PAYABLE', 'DELETE_PAYABLE',
      'CREATE_EXPENSE', 'EDIT_EXPENSE', 'DELETE_EXPENSE',
      'CREATE_CREDIT_NOTE', 'EDIT_CREDIT_NOTE', 'DELETE_CREDIT_NOTE',
      'CREATE_CARRIER', 'EDIT_CARRIER', 'DELETE_CARRIER',
      'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
      'UPLOAD_DOCUMENT', 'DELETE_DOCUMENT', 'MANAGE_DOCUMENT_EXPIRY',
      'CREATE_JOB', 'EDIT_JOB', 'DELETE_JOB',
      'MANAGE_LOAD_TENDERS', 'UPDATE_LOAD_STATUS',
      'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
      'MANAGE_INVITATIONS', 'EDIT_COMPANY',
      'MANAGE_VETTING_CONFIG', 'RUN_CARRIER_VETTING',
      'SEND_NOTIFICATION', 'MANAGE_NOTIFICATION_DELIVERY',
      'UPLOAD_DOCUMENT', 'DELETE_DOCUMENT', 'MANAGE_DOCUMENT_EXPIRY',
      'CREATE_JOB', 'EDIT_JOB', 'DELETE_JOB',
      'RUN_CARRIER_VETTING', 'VERIFY_CARRIER_DOCUMENT',
      'MANAGE_VETTING_CONFIGURATION', 'MANAGE_COMPANY_SETTINGS'
    ];
  }

  return readActions;
}

/**
 * Middleware to attach company status info to request
 */
function attachCompanyStatus(req, res, next) {
  if (req.company) {
    req.companyCanOperate = ['active', 'verified'].includes(req.company.status);
    req.companyIsReadOnly = ['pending', 'suspended'].includes(req.company.status);
    req.allowedActions = getAllowedActionsForStatus(req.company.status);
  }
  next();
}

module.exports = {
  enforceCompanyStatus,
  getAllowedActionsForStatus,
  attachCompanyStatus,
  canPerformOperations: (company) => {
    if (!company) return false;
    return ['active', 'verified'].includes(company.status);
  },
  isReadOnly: (company) => {
    if (!company) return true;
    return ['pending', 'suspended'].includes(company.status);
  }
};
