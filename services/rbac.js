/**
 * Centralized Role-Based Access Control (RBAC) Service
 * 
 * This module defines the complete role-permission matrix and provides
 * utilities for permission checking across all resources.
 * 
 * Roles by Company Type:
 * - Brokerage: broker_owner, broker_admin, broker, operations_manager, compliance_officer, finance, viewer
 * - Carrier: carrier_owner, carrier_admin, dispatcher, driver, viewer
 * - Platform: platform_admin, platform_support, viewer
 */

const mongoose = require('mongoose');

/**
 * All available permissions in the system
 */
const PERMISSIONS = {
  'VIEW_LOADS': { description: 'View loads', category: 'loads' },
  'CREATE_LOAD': { description: 'Create new loads', category: 'loads' },
  'EDIT_LOAD': { description: 'Edit existing loads', category: 'loads' },
  'ASSIGN_LOAD': { description: 'Assign carriers to loads', category: 'loads' },
  'DELETE_LOAD': { description: 'Delete loads', category: 'loads' },
  'VIEW_LOAD_FINANCIALS': { description: 'View load financials and margins', category: 'loads' },
  'MANAGE_LOAD_TENDERS': { description: 'Create and manage load tenders', category: 'loads' },
  'UPDATE_LOAD_STATUS': { description: 'Update load status (pickup, delivery, etc.)', category: 'loads' },
  'VIEW_LOAD_DOCUMENTS': { description: 'View load documents', category: 'loads' },
  'MANAGE_LOAD_DOCUMENTS': { description: 'Upload/manage load documents', category: 'loads' },
  'VIEW_CARRIER': { description: 'View carrier profiles', category: 'carriers' },
  'CREATE_CARRIER': { description: 'Create new carrier profiles', category: 'carriers' },
  'EDIT_CARRIER': { description: 'Edit carrier profiles', category: 'carriers' },
  'ASSIGN_CARRIER': { description: 'Assign carriers to loads', category: 'carriers' },
  'VIEW_CARRIER_COMPLIANCE': { description: 'View carrier compliance status', category: 'carriers' },
  'MANAGE_CARRIER_COMPLIANCE': { description: 'Manage carrier compliance (verify documents, etc.)', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_CUSTOMER': { description: 'View customer profiles', category: 'crm' },
  'CREATE_CUSTOMER': { description: 'Create new customer profiles', category: 'crm' },
  'EDIT_CUSTOMER': { description: 'Edit customer profiles', category: 'crm' },
  'VIEW_LEAD': { description: 'View leads', category: 'crm' },
  'CREATE_LEAD': { description: 'Create new leads', category: 'crm' },
  'EDIT_LEAD': { description: 'Edit leads', category: 'crm' },
  'VIEW_OPPORTUNITY': { description: 'View opportunities', category: 'crm' },
  'CREATE_OPPORTUNITY': { description: 'Create new opportunities', category: 'crm' },
  'EDIT_OPPORTUNITY': { description: 'Edit opportunities', category: 'crm' },
  'VIEW_QUOTE': { description: 'View quotes', category: 'crm' },
  'CREATE_QUOTE': { description: 'Create new quotes', category: 'crm' },
  'EDIT_QUOTE': { description: 'Edit quotes', category: 'crm' },
  'VIEW_RATE_AGREEMENT': { description: 'View rate agreements', category: 'crm' },
  'CREATE_RATE_AGREEMENT': { description: 'Create rate agreements', category: 'crm' },
  'EDIT_RATE_AGREEMENT': { description: 'Edit rate agreements', category: 'crm' },
  'VIEW_CONTACT': { description: 'View contacts', category: 'crm' },
  'CREATE_CONTACT': { description: 'Create new contacts', category: 'crm' },
  'EDIT_CONTACT': { description: 'Edit contacts', category: 'crm' },
  'MANAGE_CRM_COMMUNICATIONS': { description: 'Manage CRM communications', category: 'crm' },
  'VIEW_INVOICE': { description: 'View invoices', category: 'finance' },
  'CREATE_INVOICE': { description: 'Create new invoices', category: 'finance' },
  'EDIT_INVOICE': { description: 'Edit invoices', category: 'finance' },
  'DELETE_INVOICE': { description: 'Delete invoices', category: 'finance' },
  'VIEW_PAYABLE': { description: 'View carrier payables', category: 'finance' },
  'CREATE_PAYABLE': { description: 'Create carrier payables', category: 'finance' },
  'EDIT_PAYABLE': { description: 'Edit carrier payables', category: 'finance' },
  'VIEW_EXPENSE': { description: 'View expenses', category: 'finance' },
  'CREATE_EXPENSE': { description: 'Create expenses', category: 'finance' },
  'EDIT_EXPENSE': { description: 'Edit expenses', category: 'finance' },
  'VIEW_CREDIT_NOTE': { description: 'View credit notes', category: 'finance' },
  'CREATE_CREDIT_NOTE': { description: 'Create credit notes', category: 'finance' },
  'EDIT_CREDIT_NOTE': { description: 'Edit credit notes', category: 'finance' },
  'VIEW_FINANCIAL_REPORTS': { description: 'View financial reports', category: 'finance' },
  'EXPORT_FINANCIAL_DATA': { description: 'Export financial data', category: 'finance' },
  'MANAGE_FINANCIAL_EXPORTS': { description: 'Manage financial exports', category: 'finance' },
  'VIEW_COMPLIANCE_REVIEW': { description: 'View compliance review queue', category: 'compliance' },
  'MANAGE_VETTING_CONFIG': { description: 'Manage carrier vetting configuration', category: 'compliance' },
  'RUN_CARRIER_VETTING': { description: 'Run carrier vetting evaluation', category: 'compliance' },
  'VERIFY_CARRIER_DOCUMENT': { description: 'Verify carrier documents', category: 'compliance' },
  'REJECT_CARRIER_DOCUMENT': { description: 'Reject carrier documents', category: 'compliance' },
  'ARCHIVE_CARRIER_DOCUMENT': { description: 'Archive carrier documents', category: 'compliance' },
  'VIEW_NOTIFICATIONS': { description: 'View notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_PREFERENCES': { description: 'Manage notification preferences', category: 'notifications' },
  'SEND_NOTIFICATION': { description: 'Send notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_DELIVERY': { description: 'Manage notification delivery', category: 'notifications' },
  'VIEW_DOCUMENT': { description: 'View documents', category: 'documents' },
  'UPLOAD_DOCUMENT': { description: 'Upload documents', category: 'documents' },
  'DOWNLOAD_DOCUMENT': { description: 'Download documents', category: 'documents' },
  'DELETE_DOCUMENT': { description: 'Delete documents', category: 'documents' },
  'MANAGE_DOCUMENT_EXPIRY': { description: 'Manage document expiry', category: 'documents' },
  'VIEW_JOB': { description: 'View jobs/tasks', category: 'jobs' },
  'CREATE_JOB': { description: 'Create jobs/tasks', category: 'jobs' },
  'EDIT_JOB': { description: 'Edit jobs/tasks', category: 'jobs' },
  'DELETE_JOB': { description: 'Delete jobs/tasks', category: 'jobs' },
  'VIEW_ADAPTER': { description: 'View external adapters', category: 'integrations' },
  'CREATE_ADAPTER': { description: 'Create external adapters', category: 'integrations' },
  'EDIT_ADAPTER': { description: 'Edit external adapters', category: 'integrations' },
  'DELETE_ADAPTER': { description: 'Delete external adapters', category: 'integrations' },
  'RUN_ADAPTER': { description: 'Run external adapter sync', category: 'integrations' },
  'VIEW_COMPANY': { description: 'View company details', category: 'admin' },
  'EDIT_COMPANY': { description: 'Edit company details', category: 'admin' },
  'MANAGE_COMPANY_MEMBERS': { description: 'Invite/remove company members', category: 'admin' },
  'MANAGE_COMPANY_ROLES': { description: 'Change member roles', category: 'admin' },
  'MANAGE_INVITATIONS': { description: 'Create/revoke invitations', category: 'admin' },
  'VIEW_AUDIT_LOG': { description: 'View audit log', category: 'admin' },
  'MANAGE_COMPANY_SETTINGS': { description: 'Manage company settings', category: 'admin' },
  'MANAGE_VETTING_CONFIGURATION': { description: 'Manage vetting configuration', category: 'admin' },
  'VIEW_COMPANY_AUDIT': { description: 'View company audit log', category: 'admin' },
  'MANAGE_COMPANY_BRANDING': { description: 'Manage company branding', category: 'admin' },
  'MANAGE_NOTIFICATION_POLICIES': { description: 'Manage notification policies', category: 'admin' },
  'MANAGE_COMPANY_WORKFLOWS': { description: 'Manage approval workflows', category: 'admin' },
  'MANAGE_COMPANY_SECURITY': { description: 'Manage company security policies', category: 'admin' },
  'VIEW_SETTINGS': { description: 'View settings', category: 'settings' },
  'MANAGE_ACCOUNT_SETTINGS': { description: 'Manage account settings', category: 'settings' },
  'MANAGE_SECURITY_SETTINGS': { description: 'Manage security settings', category: 'settings' },
  'MANAGE_NOTIFICATION_SETTINGS': { description: 'Manage notification settings', category: 'settings' },
  'MANAGE_APPEARANCE_SETTINGS': { description: 'Manage appearance settings', category: 'settings' },
  'MANAGE_DATA_SETTINGS': { description: 'Manage data & sync settings', category: 'settings' },
  'MANAGE_PRIVACY_SETTINGS': { description: 'Manage privacy settings', category: 'settings' },
  'MANAGE_ADVANCED_SETTINGS': { description: 'Manage advanced settings', category: 'settings' },
  'PLATFORM_ADMIN': { description: 'Full platform administration', category: 'platform' },
  'MANAGE_PLATFORM_USERS': { description: 'Manage platform users', category: 'platform' },
  'MANAGE_PLATFORM_COMPANIES': { description: 'Manage all companies', category: 'platform' },
  'VIEW_PLATFORM_ANALYTICS': { description: 'View platform analytics', category: 'platform' },
  'MANAGE_PLATFORM_SETTINGS': { description: 'Manage platform settings', category: 'platform' },
  'MANAGE_EXTERNAL_ADAPTERS': { description: 'Manage external adapters globally', category: 'platform' },
  'VIEW_PLATFORM_AUDIT': { description: 'View platform audit log', category: 'platform' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'CREATE_CARRIER': { description: 'Create new carrier profiles', category: 'carriers' },
  'EDIT_CARRIER': { description: 'Edit carrier profiles', category: 'carriers' },
  'ASSIGN_CARRIER': { description: 'Assign carriers to loads', category: 'carriers' },
  'VIEW_CARRIER_COMPLIANCE': { description: 'View carrier compliance status', category: 'carriers' },
  'MANAGE_CARRIER_COMPLIANCE': { description: 'Manage carrier compliance (verify documents, etc.)', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'VIEW_ASSIGNMENTS': { description: 'View carrier assignments', category: 'carriers' },
  'CREATE_ASSIGNMENT': { description: 'Create carrier assignments', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_OWN_ASSIGNMENTS': { description: 'View own assignments', category: 'carriers' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'VIEW_INVOICE': { description: 'View invoices', category: 'finance' },
  'CREATE_INVOICE': { description: 'Create new invoices', category: 'finance' },
  'EDIT_INVOICE': { description: 'Edit invoices', category: 'finance' },
  'DELETE_INVOICE': { description: 'Delete invoices', category: 'finance' },
  'VIEW_PAYABLE': { description: 'View carrier payables', category: 'finance' },
  'CREATE_PAYABLE': { description: 'Create carrier payables', category: 'finance' },
  'EDIT_PAYABLE': { description: 'Edit carrier payables', category: 'finance' },
  'VIEW_EXPENSE': { description: 'View expenses', category: 'finance' },
  'CREATE_EXPENSE': { description: 'Create expenses', category: 'finance' },
  'EDIT_EXPENSE': { description: 'Edit expenses', category: 'finance' },
  'VIEW_CREDIT_NOTE': { description: 'View credit notes', category: 'finance' },
  'CREATE_CREDIT_NOTE': { description: 'Create credit notes', category: 'finance' },
  'EDIT_CREDIT_NOTE': { description: 'Edit credit notes', category: 'finance' },
  'VIEW_FINANCIAL_REPORTS': { description: 'View financial reports', category: 'finance' },
  'EXPORT_FINANCIAL_DATA': { description: 'Export financial data', category: 'finance' },
  'MANAGE_FINANCIAL_EXPORTS': { description: 'Manage financial exports', category: 'finance' },
  'VIEW_CREDIT_NOTE': { description: 'View credit notes', category: 'finance' },
  'CREATE_CREDIT_NOTE': { description: 'Create credit notes', category: 'finance' },
  'EDIT_CREDIT_NOTE': { description: 'Edit credit notes', category: 'finance' },
  'VIEW_FINANCIAL_REPORTS': { description: 'View financial reports', category: 'finance' },
  'EXPORT_FINANCIAL_DATA': { description: 'Export financial data', category: 'finance' },
  'MANAGE_FINANCIAL_EXPORTS': { description: 'Manage financial exports', category: 'finance' },
  'VIEW_COMPLIANCE_REVIEW': { description: 'View compliance review queue', category: 'compliance' },
  'MANAGE_VETTING_CONFIG': { description: 'Manage carrier vetting configuration', category: 'compliance' },
  'RUN_CARRIER_VETTING': { description: 'Run carrier vetting evaluation', category: 'compliance' },
  'VERIFY_CARRIER_DOCUMENT': { description: 'Verify carrier documents', category: 'compliance' },
  'REJECT_CARRIER_DOCUMENT': { description: 'Reject carrier documents', category: 'compliance' },
  'ARCHIVE_CARRIER_DOCUMENT': { description: 'Archive carrier documents', category: 'compliance' },
  'VIEW_NOTIFICATIONS': { description: 'View notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_PREFERENCES': { description: 'Manage notification preferences', category: 'notifications' },
  'SEND_NOTIFICATION': { description: 'Send notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_DELIVERY': { description: 'Manage notification delivery', category: 'notifications' },
  'VIEW_DOCUMENT': { description: 'View documents', category: 'documents' },
  'UPLOAD_DOCUMENT': { description: 'Upload documents', category: 'documents' },
  'DOWNLOAD_DOCUMENT': { description: 'Download documents', category: 'documents' },
  'DELETE_DOCUMENT': { description: 'Delete documents', category: 'documents' },
  'MANAGE_DOCUMENT_EXPIRY': { description: 'Manage document expiry', category: 'documents' },
  'VIEW_JOB': { description: 'View jobs/tasks', category: 'jobs' },
  'CREATE_JOB': { description: 'Create jobs/tasks', category: 'jobs' },
  'EDIT_JOB': { description: 'Edit jobs/tasks', category: 'jobs' },
  'DELETE_JOB': { description: 'Delete jobs/tasks', category: 'jobs' },
  'VIEW_ADAPTER': { description: 'View external adapters', category: 'integrations' },
  'CREATE_ADAPTER': { description: 'Create external adapters', category: 'integrations' },
  'EDIT_ADAPTER': { description: 'Edit external adapters', category: 'integrations' },
  'DELETE_ADAPTER': { description: 'Delete external adapters', category: 'integrations' },
  'RUN_ADAPTER': { description: 'Run external adapter sync', category: 'integrations' },
  'VIEW_COMPANY': { description: 'View company details', category: 'admin' },
  'EDIT_COMPANY': { description: 'Edit company details', category: 'admin' },
  'MANAGE_COMPANY_MEMBERS': { description: 'Invite/remove company members', category: 'admin' },
  'MANAGE_COMPANY_ROLES': { description: 'Change member roles', category: 'admin' },
  'MANAGE_INVITATIONS': { description: 'Create/revoke invitations', category: 'admin' },
  'VIEW_AUDIT_LOG': { description: 'View audit log', category: 'admin' },
  'MANAGE_COMPANY_SETTINGS': { description: 'Manage company settings', category: 'admin' },
  'MANAGE_VETTING_CONFIGURATION': { description: 'Manage vetting configuration', category: 'admin' },
  'VIEW_COMPANY_AUDIT': { description: 'View company audit log', category: 'admin' },
  'MANAGE_COMPANY_BRANDING': { description: 'Manage company branding', category: 'admin' },
  'MANAGE_NOTIFICATION_POLICIES': { description: 'Manage notification policies', category: 'admin' },
  'MANAGE_COMPANY_WORKFLOWS': { description: 'Manage approval workflows', category: 'admin' },
  'MANAGE_COMPANY_SECURITY': { description: 'Manage company security policies', category: 'admin' },
  'MANAGE_COMPANY_BRANDING': { description: 'Manage company branding', category: 'admin' },
  'MANAGE_NOTIFICATION_POLICIES': { description: 'Manage notification policies', category: 'admin' },
  'MANAGE_COMPANY_WORKFLOWS': { description: 'Manage approval workflows', category: 'admin' },
  'MANAGE_COMPANY_SECURITY': { description: 'Manage company security policies', category: 'admin' },
  'VIEW_SETTINGS': { description: 'View settings', category: 'settings' },
  'MANAGE_ACCOUNT_SETTINGS': { description: 'Manage account settings', category: 'settings' },
  'MANAGE_SECURITY_SETTINGS': { description: 'Manage security settings', category: 'settings' },
  'MANAGE_NOTIFICATION_SETTINGS': { description: 'Manage notification settings', category: 'settings' },
  'MANAGE_APPEARANCE_SETTINGS': { description: 'Manage appearance settings', category: 'settings' },
  'MANAGE_DATA_SETTINGS': { description: 'Manage data & sync settings', category: 'settings' },
  'MANAGE_PRIVACY_SETTINGS': { description: 'Manage privacy settings', category: 'settings' },
  'MANAGE_ADVANCED_SETTINGS': { description: 'Manage advanced settings', category: 'settings' },
  'PLATFORM_ADMIN': { description: 'Full platform administration', category: 'platform' },
  'MANAGE_PLATFORM_USERS': { description: 'Manage platform users', category: 'platform' },
  'MANAGE_PLATFORM_COMPANIES': { description: 'Manage all companies', category: 'platform' },
  'VIEW_PLATFORM_ANALYTICS': { description: 'View platform analytics', category: 'platform' },
  'MANAGE_PLATFORM_SETTINGS': { description: 'Manage platform settings', category: 'platform' },
  'MANAGE_EXTERNAL_ADAPTERS': { description: 'Manage external adapters globally', category: 'platform' },
  'VIEW_PLATFORM_AUDIT': { description: 'View platform audit log', category: 'platform' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'CREATE_CARRIER': { description: 'Create new carrier profiles', category: 'carriers' },
  'EDIT_CARRIER': { description: 'Edit carrier profiles', category: 'carriers' },
  'ASSIGN_CARRIER': { description: 'Assign carriers to loads', category: 'carriers' },
  'VIEW_CARRIER_COMPLIANCE': { description: 'View carrier compliance status', category: 'carriers' },
  'MANAGE_CARRIER_COMPLIANCE': { description: 'Manage carrier compliance (verify documents, etc.)', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'VIEW_ASSIGNMENTS': { description: 'View carrier assignments', category: 'carriers' },
  'CREATE_ASSIGNMENT': { description: 'Create carrier assignments', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_OWN_CARRIER': { description: 'View own carrier profile', category: 'carriers' },
  'VIEW_ASSIGNMENTS': { description: 'View carrier assignments', category: 'carriers' },
  'CREATE_ASSIGNMENT': { description: 'Create carrier assignments', category: 'carriers' },
  'VIEW_CARRIER_DOCUMENTS': { description: 'View carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_DOCUMENTS': { description: 'Upload/manage carrier documents', category: 'carriers' },
  'MANAGE_CARRIER_CONTACTS': { description: 'Manage carrier contacts/equipment/drivers', category: 'carriers' },
  'VIEW_OWN_ASSIGNMENTS': { description: 'View own assignments', category: 'carriers' },
  'VIEW_INVOICE': { description: 'View invoices', category: 'finance' },
  'CREATE_INVOICE': { description: 'Create new invoices', category: 'finance' },
  'EDIT_INVOICE': { description: 'Edit invoices', category: 'finance' },
  'DELETE_INVOICE': { description: 'Delete invoices', category: 'finance' },
  'VIEW_PAYABLE': { description: 'View carrier payables', category: 'finance' },
  'CREATE_PAYABLE': { description: 'Create carrier payables', category: 'finance' },
  'EDIT_PAYABLE': { description: 'Edit carrier payables', category: 'finance' },
  'VIEW_EXPENSE': { description: 'View expenses', category: 'finance' },
  'CREATE_EXPENSE': { description: 'Create expenses', category: 'finance' },
  'EDIT_EXPENSE': { description: 'Edit expenses', category: 'finance' },
  'VIEW_CREDIT_NOTE': { description: 'View credit notes', category: 'finance' },
  'CREATE_CREDIT_NOTE': { description: 'Create credit notes', category: 'finance' },
  'EDIT_CREDIT_NOTE': { description: 'Edit credit notes', category: 'finance' },
  'VIEW_FINANCIAL_REPORTS': { description: 'View financial reports', category: 'finance' },
  'EXPORT_FINANCIAL_DATA': { description: 'Export financial data', category: 'finance' },
  'MANAGE_FINANCIAL_EXPORTS': { description: 'Manage financial exports', category: 'finance' },
  'VIEW_COMPLIANCE_REVIEW': { description: 'View compliance review queue', category: 'compliance' },
  'MANAGE_VETTING_CONFIG': { description: 'Manage carrier vetting configuration', category: 'compliance' },
  'RUN_CARRIER_VETTING': { description: 'Run carrier vetting evaluation', category: 'compliance' },
  'VERIFY_CARRIER_DOCUMENT': { description: 'Verify carrier documents', category: 'compliance' },
  'REJECT_CARRIER_DOCUMENT': { description: 'Reject carrier documents', category: 'compliance' },
  'ARCHIVE_CARRIER_DOCUMENT': { description: 'Archive carrier documents', category: 'compliance' },
  'VIEW_NOTIFICATIONS': { description: 'View notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_PREFERENCES': { description: 'Manage notification preferences', category: 'notifications' },
  'SEND_NOTIFICATION': { description: 'Send notifications', category: 'notifications' },
  'MANAGE_NOTIFICATION_DELIVERY': { description: 'Manage notification delivery', category: 'notifications' },
  'VIEW_DOCUMENT': { description: 'View documents', category: 'documents' },
  'UPLOAD_DOCUMENT': { description: 'Upload documents', category: 'documents' },
  'DOWNLOAD_DOCUMENT': { description: 'Download documents', category: 'documents' },
  'DELETE_DOCUMENT': { description: 'Delete documents', category: 'documents' },
  'MANAGE_DOCUMENT_EXPIRY': { description: 'Manage document expiry', category: 'documents' },
  'VIEW_JOB': { description: 'View jobs/tasks', category: 'jobs' },
  'CREATE_JOB': { description: 'Create jobs/tasks', category: 'jobs' },
  'EDIT_JOB': { description: 'Edit jobs/tasks', category: 'jobs' },
  'DELETE_JOB': { description: 'Delete jobs/tasks', category: 'jobs' },
  'VIEW_ADAPTER': { description: 'View external adapters', category: 'integrations' },
  'CREATE_ADAPTER': { description: 'Create external adapters', category: 'integrations' },
  'EDIT_ADAPTER': { description: 'Edit external adapters', category: 'integrations' },
  'DELETE_ADAPTER': { description: 'Delete external adapters', category: 'integrations' },
  'RUN_ADAPTER': { description: 'Run external adapter sync', category: 'integrations' },
  'VIEW_COMPANY': { description: 'View company details', category: 'admin' },
  'EDIT_COMPANY': { description: 'Edit company details', category: 'admin' },
  'MANAGE_COMPANY_MEMBERS': { description: 'Invite/remove company members', category: 'admin' },
  'MANAGE_COMPANY_ROLES': { description: 'Change member roles', category: 'admin' },
  'MANAGE_INVITATIONS': { description: 'Create/revoke invitations', category: 'admin' },
  'VIEW_AUDIT_LOG': { description: 'View audit log', category: 'admin' },
  'MANAGE_COMPANY_SETTINGS': { description: 'Manage company settings', category: 'admin' },
  'MANAGE_VETTING_CONFIGURATION': { description: 'Manage vetting configuration', category: 'admin' },
  'VIEW_COMPANY_AUDIT': { description: 'View company audit log', category: 'admin' },
  'MANAGE_COMPANY_BRANDING': { description: 'Manage company branding', category: 'admin' },
  'MANAGE_NOTIFICATION_POLICIES': { description: 'Manage notification policies', category: 'admin' },
  'MANAGE_COMPANY_WORKFLOWS': { description: 'Manage approval workflows', category: 'admin' },
  'MANAGE_COMPANY_SECURITY': { description: 'Manage company security policies', category: 'admin' },
  'MANAGE_COMPANY_BRANDING': { description: 'Manage company branding', category: 'admin' },
  'MANAGE_NOTIFICATION_POLICIES': { description: 'Manage notification policies', category: 'admin' },
  'MANAGE_COMPANY_WORKFLOWS': { description: 'Manage approval workflows', category: 'admin' },
  'MANAGE_COMPANY_SECURITY': { description: 'Manage company security policies', category: 'admin' },
  'VIEW_SETTINGS': { description: 'View settings', category: 'settings' },
  'MANAGE_ACCOUNT_SETTINGS': { description: 'Manage account settings', category: 'settings' },
  'MANAGE_SECURITY_SETTINGS': { description: 'Manage security settings', category: 'settings' },
  'MANAGE_NOTIFICATION_SETTINGS': { description: 'Manage notification settings', category: 'settings' },
  'MANAGE_APPEARANCE_SETTINGS': { description: 'Manage appearance settings', category: 'settings' },
  'MANAGE_DATA_SETTINGS': { description: 'Manage data & sync settings', category: 'settings' },
  'MANAGE_PRIVACY_SETTINGS': { description: 'Manage privacy settings', category: 'settings' },
  'MANAGE_ADVANCED_SETTINGS': { description: 'Manage advanced settings', category: 'settings' },
  'PLATFORM_ADMIN': { description: 'Full platform administration', category: 'platform' },
  'MANAGE_PLATFORM_USERS': { description: 'Manage platform users', category: 'platform' },
  'MANAGE_PLATFORM_COMPANIES': { description: 'Manage all companies', category: 'platform' },
  'VIEW_PLATFORM_ANALYTICS': { description: 'View platform analytics', category: 'platform' },
  'MANAGE_PLATFORM_SETTINGS': { description: 'Manage platform settings', category: 'platform' },
  'MANAGE_EXTERNAL_ADAPTERS': { description: 'Manage external adapters globally', category: 'platform' },
  'VIEW_PLATFORM_AUDIT': { description: 'View platform audit log', category: 'platform' }
};

const ROLE_PERMISSIONS = {
  'broker_owner': [
    'VIEW_LOADS', 'CREATE_LOAD', 'EDIT_LOAD', 'ASSIGN_LOAD', 'DELETE_LOAD',
    'VIEW_LOAD_FINANCIALS', 'MANAGE_LOAD_TENDERS', 'UPDATE_LOAD_STATUS',
    'VIEW_LOAD_DOCUMENTS', 'MANAGE_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'CREATE_CARRIER', 'EDIT_CARRIER', 'ASSIGN_CARRIER',
    'VIEW_CARRIER_COMPLIANCE', 'MANAGE_CARRIER_COMPLIANCE',
    'VIEW_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_CONTACTS',
    'VIEW_CUSTOMER', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER',
    'VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD',
    'VIEW_OPPORTUNITY', 'CREATE_OPPORTUNITY', 'EDIT_OPPORTUNITY',
    'VIEW_QUOTE', 'CREATE_QUOTE', 'EDIT_QUOTE',
    'VIEW_RATE_AGREEMENT', 'CREATE_RATE_AGREEMENT', 'EDIT_RATE_AGREEMENT',
    'VIEW_CONTACT', 'CREATE_CONTACT', 'EDIT_CONTACT',
    'MANAGE_CRM_COMMUNICATIONS',
    'VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'DELETE_INVOICE',
    'VIEW_PAYABLE', 'CREATE_PAYABLE', 'EDIT_PAYABLE',
    'VIEW_EXPENSE', 'CREATE_EXPENSE', 'EDIT_EXPENSE',
    'VIEW_CREDIT_NOTE', 'CREATE_CREDIT_NOTE', 'EDIT_CREDIT_NOTE',
    'VIEW_FINANCIAL_REPORTS', 'EXPORT_FINANCIAL_DATA', 'MANAGE_FINANCIAL_EXPORTS',
    'VIEW_COMPLIANCE_REVIEW', 'MANAGE_VETTING_CONFIG', 'RUN_CARRIER_VETTING',
    'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES', 'SEND_NOTIFICATION',
    'MANAGE_NOTIFICATION_DELIVERY',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'DELETE_DOCUMENT',
    'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB', 'DELETE_JOB',
    'VIEW_ADAPTER', 'CREATE_ADAPTER', 'EDIT_ADAPTER', 'DELETE_ADAPTER', 'RUN_ADAPTER',
    'VIEW_COMPANY', 'EDIT_COMPANY', 'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
    'MANAGE_INVITATIONS', 'VIEW_AUDIT_LOG', 'MANAGE_COMPANY_SETTINGS',
    'MANAGE_VETTING_CONFIGURATION', 'VIEW_COMPANY_AUDIT', 'MANAGE_COMPANY_BRANDING',
    'MANAGE_NOTIFICATION_POLICIES', 'MANAGE_COMPANY_WORKFLOWS', 'MANAGE_COMPANY_SECURITY',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_SECURITY_SETTINGS',
    'MANAGE_NOTIFICATION_SETTINGS', 'MANAGE_APPEARANCE_SETTINGS', 'MANAGE_DATA_SETTINGS',
    'MANAGE_PRIVACY_SETTINGS', 'MANAGE_ADVANCED_SETTINGS'
  ],
  'broker_admin': [
    'VIEW_LOADS', 'CREATE_LOAD', 'EDIT_LOAD', 'ASSIGN_LOAD',
    'VIEW_LOAD_FINANCIALS', 'MANAGE_LOAD_TENDERS', 'UPDATE_LOAD_STATUS',
    'VIEW_LOAD_DOCUMENTS', 'MANAGE_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'CREATE_CARRIER', 'EDIT_CARRIER', 'ASSIGN_CARRIER',
    'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_DOCUMENTS',
    'MANAGE_CARRIER_CONTACTS',
    'VIEW_CUSTOMER', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER',
    'VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD',
    'VIEW_OPPORTUNITY', 'CREATE_OPPORTUNITY', 'EDIT_OPPORTUNITY',
    'VIEW_QUOTE', 'CREATE_QUOTE', 'EDIT_QUOTE',
    'VIEW_RATE_AGREEMENT', 'CREATE_RATE_AGREEMENT', 'EDIT_RATE_AGREEMENT',
    'VIEW_CONTACT', 'CREATE_CONTACT', 'EDIT_CONTACT',
    'MANAGE_CRM_COMMUNICATIONS',
    'VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE',
    'VIEW_PAYABLE', 'CREATE_PAYABLE', 'EDIT_PAYABLE',
    'VIEW_EXPENSE', 'CREATE_EXPENSE', 'EDIT_EXPENSE',
    'VIEW_CREDIT_NOTE', 'CREATE_CREDIT_NOTE', 'EDIT_CREDIT_NOTE',
    'VIEW_FINANCIAL_REPORTS', 'EXPORT_FINANCIAL_DATA',
    'VIEW_COMPLIANCE_REVIEW', 'RUN_CARRIER_VETTING',
    'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES', 'SEND_NOTIFICATION',
    'MANAGE_NOTIFICATION_DELIVERY',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'DELETE_DOCUMENT',
    'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB',
    'VIEW_ADAPTER', 'CREATE_ADAPTER', 'EDIT_ADAPTER', 'RUN_ADAPTER',
    'VIEW_COMPANY', 'EDIT_COMPANY', 'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
    'MANAGE_INVITATIONS', 'VIEW_AUDIT_LOG', 'MANAGE_COMPANY_SETTINGS',
    'MANAGE_VETTING_CONFIGURATION', 'VIEW_COMPANY_AUDIT', 'MANAGE_COMPANY_BRANDING',
    'MANAGE_NOTIFICATION_POLICIES',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_SECURITY_SETTINGS',
    'MANAGE_NOTIFICATION_SETTINGS', 'MANAGE_APPEARANCE_SETTINGS',
    'MANAGE_DATA_SETTINGS', 'MANAGE_PRIVACY_SETTINGS', 'MANAGE_ADVANCED_SETTINGS'
  ],
  'broker': [
    'VIEW_LOADS', 'CREATE_LOAD', 'EDIT_LOAD',
    'VIEW_LOAD_DOCUMENTS', 'MANAGE_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_CUSTOMER', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER',
    'VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD',
    'VIEW_OPPORTUNITY', 'CREATE_OPPORTUNITY', 'EDIT_OPPORTUNITY',
    'VIEW_QUOTE', 'CREATE_QUOTE', 'EDIT_QUOTE',
    'VIEW_RATE_AGREEMENT', 'VIEW_CONTACT', 'CREATE_CONTACT', 'EDIT_CONTACT',
    'MANAGE_CRM_COMMUNICATIONS',
    'VIEW_INVOICE', 'VIEW_PAYABLE', 'VIEW_EXPENSE', 'VIEW_CREDIT_NOTE',
    'VIEW_FINANCIAL_REPORTS',
    'VIEW_COMPLIANCE_REVIEW',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB',
    'VIEW_ADAPTER', 'RUN_ADAPTER',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS',
    'MANAGE_APPEARANCE_SETTINGS', 'MANAGE_DATA_SETTINGS', 'MANAGE_PRIVACY_SETTINGS'
  ],
  'operations_manager': [
    'VIEW_LOADS', 'CREATE_LOAD', 'EDIT_LOAD', 'ASSIGN_LOAD',
    'UPDATE_LOAD_STATUS', 'VIEW_LOAD_DOCUMENTS', 'MANAGE_LOAD_DOCUMENTS',
    'MANAGE_LOAD_TENDERS',
    'VIEW_CARRIER', 'ASSIGN_CARRIER', 'VIEW_CARRIER_COMPLIANCE',
    'VIEW_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_DOCUMENTS',
    'VIEW_CUSTOMER', 'VIEW_LEAD', 'VIEW_OPPORTUNITY',
    'VIEW_QUOTE', 'VIEW_RATE_AGREEMENT', 'VIEW_CONTACT',
    'VIEW_INVOICE', 'VIEW_PAYABLE', 'VIEW_FINANCIAL_REPORTS',
    'VIEW_COMPLIANCE_REVIEW', 'RUN_CARRIER_VETTING',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES', 'SEND_NOTIFICATION',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS',
    'MANAGE_APPEARANCE_SETTINGS'
  ],
  'compliance_officer': [
    'VIEW_LOADS', 'VIEW_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'MANAGE_CARRIER_COMPLIANCE', 'MANAGE_CARRIER_DOCUMENTS',
    'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
    'VIEW_CUSTOMER', 'VIEW_CARRIER',
    'VIEW_COMPLIANCE_REVIEW', 'MANAGE_VETTING_CONFIG', 'RUN_CARRIER_VETTING',
    'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_COMPANY', 'MANAGE_VETTING_CONFIGURATION', 'VIEW_COMPANY_AUDIT',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS',
    'MANAGE_APPEARANCE_SETTINGS', 'MANAGE_PRIVACY_SETTINGS'
  ],
  'finance': [
    'VIEW_LOADS', 'VIEW_LOAD_FINANCIALS', 'VIEW_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE',
    'VIEW_CUSTOMER', 'VIEW_LEAD', 'VIEW_OPPORTUNITY',
    'VIEW_QUOTE', 'VIEW_RATE_AGREEMENT', 'VIEW_CONTACT',
    'VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'DELETE_INVOICE',
    'VIEW_PAYABLE', 'CREATE_PAYABLE', 'EDIT_PAYABLE',
    'VIEW_EXPENSE', 'CREATE_EXPENSE', 'EDIT_EXPENSE',
    'VIEW_CREDIT_NOTE', 'CREATE_CREDIT_NOTE', 'EDIT_CREDIT_NOTE',
    'VIEW_FINANCIAL_REPORTS', 'EXPORT_FINANCIAL_DATA', 'MANAGE_FINANCIAL_EXPORTS',
    'VIEW_COMPLIANCE_REVIEW',
    'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'MANAGE_DOCUMENT_EXPIRY',
    'VIEW_JOB',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS',
    'MANAGE_APPEARANCE_SETTINGS', 'MANAGE_DATA_SETTINGS', 'MANAGE_PRIVACY_SETTINGS'
  ],
  'viewer': [
    'VIEW_LOADS', 'VIEW_LOAD_DOCUMENTS',
    'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_CUSTOMER', 'VIEW_LEAD', 'VIEW_OPPORTUNITY',
    'VIEW_QUOTE', 'VIEW_RATE_AGREEMENT', 'VIEW_CONTACT',
    'VIEW_INVOICE', 'VIEW_PAYABLE', 'VIEW_EXPENSE', 'VIEW_CREDIT_NOTE',
    'VIEW_FINANCIAL_REPORTS',
    'VIEW_COMPLIANCE_REVIEW',
    'VIEW_NOTIFICATIONS',
    'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_JOB',
    'VIEW_COMPANY', 'VIEW_AUDIT_LOG', 'VIEW_COMPANY_AUDIT',
    'VIEW_SETTINGS'
  ],
  'carrier_owner': [
    'VIEW_OWN_CARRIER', 'CREATE_CARRIER', 'EDIT_CARRIER',
    'ASSIGN_CARRIER', 'VIEW_ASSIGNMENTS', 'CREATE_ASSIGNMENT',
    'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'MANAGE_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_CONTACTS',
    'VIEW_ASSIGNMENTS', 'CREATE_ASSIGNMENT',
    'VIEW_INVOICE', 'VIEW_PAYABLE',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB',
    'VIEW_COMPANY', 'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
    'MANAGE_INVITATIONS', 'VIEW_AUDIT_LOG',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_SECURITY_SETTINGS',
    'MANAGE_NOTIFICATION_SETTINGS', 'MANAGE_APPEARANCE_SETTINGS'
  ],
  'carrier_admin': [
    'VIEW_OWN_CARRIER', 'EDIT_CARRIER', 'ASSIGN_CARRIER',
    'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'MANAGE_CARRIER_DOCUMENTS',
    'VIEW_ASSIGNMENTS', 'CREATE_ASSIGNMENT',
    'VIEW_INVOICE', 'VIEW_PAYABLE',
    'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB',
    'VIEW_COMPANY', 'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
    'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS'
  ],
  'dispatcher': [
    'VIEW_ASSIGNMENTS', 'CREATE_ASSIGNMENT', 'VIEW_CARRIER',
    'VIEW_CARRIER_COMPLIANCE', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_JOB', 'VIEW_INVOICE',
    'VIEW_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS'
  ],
  'driver': [
    'VIEW_OWN_ASSIGNMENTS',
    'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_SETTINGS', 'MANAGE_NOTIFICATION_SETTINGS'
  ],
  'platform_admin': [
    'PLATFORM_ADMIN',
    'MANAGE_PLATFORM_USERS', 'MANAGE_PLATFORM_COMPANIES',
    'VIEW_PLATFORM_ANALYTICS', 'MANAGE_PLATFORM_SETTINGS',
    'MANAGE_EXTERNAL_ADAPTERS', 'VIEW_PLATFORM_AUDIT'
  ],
  'platform_support': [
    'VIEW_LOADS', 'VIEW_CARRIER', 'VIEW_CARRIER_COMPLIANCE',
    'VIEW_COMPLIANCE_REVIEW', 'VIEW_CARRIER_DOCUMENTS',
    'VIEW_CUSTOMER', 'VIEW_INVOICE', 'VIEW_PAYABLE',
    'VIEW_NOTIFICATIONS', 'VIEW_NOTIFICATION_DELIVERY',
    'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT',
    'VIEW_AUDIT_LOG', 'VIEW_COMPANY_AUDIT',
    'VIEW_SETTINGS'
  ]
};

/**
 * Check if a role has a specific permission
 * @param {string} role - The role to check
 * @param {string} permission - The permission to check
 * @returns {boolean}
 */
function roleHasPermission(role, permission) {
  if (role === 'platform_admin') return true;
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission) || permissions.includes('PLATFORM_ADMIN');
}

/**
 * Check if a role has any of the given permissions
 * @param {string} role - The role to check
 * @param {string[]} permissions - Array of permissions to check
 * @returns {boolean}
 */
function roleHasAnyPermission(role, permissions) {
  return permissions.some(p => roleHasPermission(role, p));
}

/**
 * Check if a role has all of the given permissions
 * @param {string} role - The role to check
 * @param {string[]} permissions - Array of permissions to check
 * @returns {boolean}
 */
function roleHasAllPermissions(role, permissions) {
  return permissions.every(p => roleHasPermission(role, p));
}

/**
 * Get all permissions for a role
 * @param {string} role - The role
 * @returns {string[]}
 */
function getPermissionsForRole(role) {
  if (role === 'platform_admin') {
    return [
      'VIEW_LOADS', 'CREATE_LOAD', 'EDIT_LOAD', 'ASSIGN_LOAD', 'DELETE_LOAD',
      'VIEW_LOAD_FINANCIALS', 'MANAGE_LOAD_TENDERS', 'UPDATE_LOAD_STATUS',
      'VIEW_LOAD_DOCUMENTS', 'MANAGE_LOAD_DOCUMENTS',
      'VIEW_CARRIER', 'CREATE_CARRIER', 'EDIT_CARRIER', 'ASSIGN_CARRIER',
      'VIEW_CARRIER_COMPLIANCE', 'MANAGE_CARRIER_COMPLIANCE',
      'VIEW_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_DOCUMENTS', 'MANAGE_CARRIER_CONTACTS',
      'VIEW_CUSTOMER', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER',
      'VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD',
      'VIEW_OPPORTUNITY', 'CREATE_OPPORTUNITY', 'EDIT_OPPORTUNITY',
      'VIEW_QUOTE', 'CREATE_QUOTE', 'EDIT_QUOTE',
      'VIEW_RATE_AGREEMENT', 'CREATE_RATE_AGREEMENT', 'EDIT_RATE_AGREEMENT',
      'VIEW_CONTACT', 'CREATE_CONTACT', 'EDIT_CONTACT',
      'MANAGE_CRM_COMMUNICATIONS',
      'VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'DELETE_INVOICE',
      'VIEW_PAYABLE', 'CREATE_PAYABLE', 'EDIT_PAYABLE',
      'VIEW_EXPENSE', 'CREATE_EXPENSE', 'EDIT_EXPENSE',
      'VIEW_CREDIT_NOTE', 'CREATE_CREDIT_NOTE', 'EDIT_CREDIT_NOTE',
      'VIEW_FINANCIAL_REPORTS', 'EXPORT_FINANCIAL_DATA', 'MANAGE_FINANCIAL_EXPORTS',
      'VIEW_COMPLIANCE_REVIEW', 'MANAGE_VETTING_CONFIG', 'RUN_CARRIER_VETTING',
      'VERIFY_CARRIER_DOCUMENT', 'REJECT_CARRIER_DOCUMENT', 'ARCHIVE_CARRIER_DOCUMENT',
      'VIEW_NOTIFICATIONS', 'MANAGE_NOTIFICATION_PREFERENCES', 'SEND_NOTIFICATION',
      'MANAGE_NOTIFICATION_DELIVERY',
      'VIEW_DOCUMENT', 'UPLOAD_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'DELETE_DOCUMENT',
      'MANAGE_DOCUMENT_EXPIRY',
      'VIEW_JOB', 'CREATE_JOB', 'EDIT_JOB', 'DELETE_JOB',
      'VIEW_ADAPTER', 'CREATE_ADAPTER', 'EDIT_ADAPTER', 'DELETE_ADAPTER', 'RUN_ADAPTER',
      'VIEW_COMPANY', 'EDIT_COMPANY', 'MANAGE_COMPANY_MEMBERS', 'MANAGE_COMPANY_ROLES',
      'MANAGE_INVITATIONS', 'VIEW_AUDIT_LOG', 'MANAGE_COMPANY_SETTINGS',
      'MANAGE_VETTING_CONFIGURATION', 'VIEW_COMPANY_AUDIT', 'MANAGE_COMPANY_BRANDING',
      'MANAGE_NOTIFICATION_POLICIES', 'MANAGE_COMPANY_WORKFLOWS', 'MANAGE_COMPANY_SECURITY',
      'VIEW_SETTINGS', 'MANAGE_ACCOUNT_SETTINGS', 'MANAGE_SECURITY_SETTINGS',
      'MANAGE_NOTIFICATION_SETTINGS', 'MANAGE_APPEARANCE_SETTINGS', 'MANAGE_DATA_SETTINGS',
      'MANAGE_PRIVACY_SETTINGS', 'MANAGE_ADVANCED_SETTINGS',
      'PLATFORM_ADMIN',
      'MANAGE_PLATFORM_USERS', 'MANAGE_PLATFORM_COMPANIES',
      'VIEW_PLATFORM_ANALYTICS', 'MANAGE_PLATFORM_SETTINGS',
      'MANAGE_EXTERNAL_ADAPTERS', 'VIEW_PLATFORM_AUDIT'
    ];
  }
  return ROLE_PERMISSIONS[role] || [];
}

/**
 * Get all roles that have a specific permission
 * @param {string} permission - The permission
 * @returns {string[]}
 */
function getRolesWithPermission(permission) {
  const roles = [];
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    if (permissions.includes(permission) || permissions.includes('PLATFORM_ADMIN')) {
      roles.push(role);
    }
  }
  return roles;
}

/**
 * Check if a role is valid for a company type
 * @param {string} role - The role
 * @param {string} companyType - The company type ('brokerage', 'carrier', 'platform')
 * @returns {boolean}
 */
function isRoleValidForCompanyType(role, companyType) {
  const validRoles = {
    'brokerage': ['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer'],
    'carrier': ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer'],
    'platform': ['platform_admin', 'platform_support', 'viewer']
  };
  return validRoles[companyType]?.includes(role) ?? false;
}

/**
 * Get valid roles for a company type
 * @param {string} companyType - The company type
 * @returns {string[]}
 */
function getValidRolesForCompanyType(companyType) {
  return {
    'brokerage': ['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer'],
    'carrier': ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer'],
    'platform': ['platform_admin', 'platform_support', 'viewer']
  }[companyType] || [];
}

/**
 * Middleware factory for permission-based authorization
 * @param {...string} requiredPermissions - Required permissions (user must have ALL)
 * @returns {Function} Express middleware
 */
function requirePermissions(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.membership) {
      return res.status(403).json({
        success: false,
        error: 'Company membership context required',
        code: 'MEMBERSHIP_REQUIRED'
      });
    }
    const role = req.membership.role;
    const hasAll = requiredPermissions.every(p => roleHasPermission(role, p));
    if (!hasAll) {
      const missing = requiredPermissions.filter(p => !roleHasPermission(role, p));
      return res.status(403).json({
        success: false,
        error: `Forbidden: requires permissions ${missing.join(', ')}`,
        code: 'FORBIDDEN_PERMISSION',
        missingPermissions: missing,
        userRole: role
      });
    }
    return next();
  };
}

/**
 * Middleware factory for permission-based authorization (any of)
 * @param {...string} requiredPermissions - Required permissions (user must have AT LEAST ONE)
 * @returns {Function} Express middleware
 */
function requireAnyPermission(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.membership) {
      return res.status(403).json({
        success: false,
        error: 'Company membership context required',
        code: 'MEMBERSHIP_REQUIRED'
      });
    }
    const role = req.membership.role;
    const hasAny = requiredPermissions.some(p => roleHasPermission(role, p));
    if (!hasAny) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: requires at least one of ${requiredPermissions.join(', ')}`,
        code: 'FORBIDDEN_PERMISSION',
        requiredPermissions,
        userRole: role
      });
    }
    return next();
  };
}

/**
 * Check if user can access a resource based on ownership
 * @param {Object} req - Express request
 * @param {Object} resource - Resource object with company/user fields
 * @param {string} ownershipField - Field to check ownership against (default: 'company')
 * @returns {boolean}
 */
function canAccessResource(req, resource, ownershipField = 'company') {
  if (!req.membership || !req.companyId) return false;
  if (!resource) return false;
  const resourceCompanyId = resource[ownershipField];
  if (!resourceCompanyId) return false;
  return String(resourceCompanyId) === String(req.companyId);
}

/**
 * Check if user is the owner of a resource
 * @param {Object} req - Express request
 * @param {Object} resource - Resource object
 * @returns {boolean}
 */
function isResourceOwner(req, resource) {
  if (!req.user || !resource) return false;
  const ownerId = resource.owner || resource.user || resource.createdBy;
  if (!ownerId) return false;
  return String(ownerId) === String(req.user.id);
}

/**
 * Check if user can perform an action on a resource
 * @param {Object} req - Express request
 * @param {string} action - Action to check (e.g., 'EDIT_LOAD')
 * @param {Object} resource - Resource object
 * @param {Object} options - Additional options
 * @returns {boolean}
 */
function canPerformAction(req, action, resource, options = {}) {
  if (!req.membership || !roleHasPermission(req.membership.role, action)) {
    return false;
  }
  if (options.requireOwnership && !isResourceOwner(req, resource)) {
    return false;
  }
  if (options.requireCompanyAccess && !canAccessResource(req, resource)) {
    return false;
  }
  if (req.company && req.company.status === 'suspended') {
    const readActions = ['VIEW_LOADS', 'VIEW_CARRIER', 'VIEW_CUSTOMER', 'VIEW_INVOICE', 
                         'VIEW_PAYABLE', 'VIEW_EXPENSE', 'VIEW_COMPLIANCE_REVIEW',
                         'VIEW_DOCUMENT', 'DOWNLOAD_DOCUMENT', 'VIEW_JOB',
                         'VIEW_COMPANY', 'VIEW_AUDIT_LOG', 'VIEW_SETTINGS'];
    if (!readActions.includes(action)) {
      return false;
    }
  }
  return true;
}

/**
 * Check if a role has a specific permission
 * @param {string} role - The role to check
 * @param {string} permission - The permission to check
 * @returns {boolean}
 */
function roleHasPermission(role, permission) {
  if (role === 'platform_admin') return true;
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission) || permissions.includes('PLATFORM_ADMIN');
}

/**
 * Check if a role is valid for a company type
 * @param {string} role - The role
 * @param {string} companyType - The company type ('brokerage', 'carrier', 'platform')
 * @returns {boolean}
 */
function isRoleValidForCompanyType(role, companyType) {
  const validRoles = {
    'brokerage': ['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer'],
    'carrier': ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer'],
    'platform': ['platform_admin', 'platform_support', 'viewer']
  };
  return validRoles[companyType]?.includes(role) ?? false;
}

/**
 * Get valid roles for a company type
 * @param {string} companyType - The company type
 * @returns {string[]}
 */
function getValidRolesForCompanyType(companyType) {
  return {
    'brokerage': ['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer'],
    'carrier': ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer'],
    'platform': ['platform_admin', 'platform_support', 'viewer']
  }[companyType] || [];
}

module.exports = {
  PERMISSIONS: {},
  ROLE_PERMISSIONS,
  roleHasPermission,
  roleHasAnyPermission: (role, permissions) => permissions.some(p => roleHasPermission(role, p)),
  roleHasAllPermissions: (role, permissions) => permissions.every(p => roleHasPermission(role, p)),
  getPermissionsForRole,
  getRolesWithPermission,
  isRoleValidForCompanyType,
  getValidRolesForCompanyType,
  requirePermissions,
  requireAnyPermission,
  canAccessResource,
  isResourceOwner,
  canPerformAction
};
