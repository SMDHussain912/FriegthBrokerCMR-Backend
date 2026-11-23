const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const { requirePermissions } = require('../services/rbac');
const LoadTemplate = require('../models/LoadTemplate');
const Load = require('../models/Load');
const NumberSequence = require('../models/NumberSequence');
const { recordAuditEvent } = require('../services/auditService');

/**
 * @route   POST /api/load-templates
 * @desc    Create load template
 * @access  Authenticated (broker)
 */
router.post('/', requireAuth, requireCompanyContext, requirePermissions('CREATE_LOAD'), async (req, res, next) => {
  try {
    const { name, description, isRecurring, recurrence, ...templateData } = req.body || {};

    if (!name) {
      return res.status(400).json({ success: false, error: 'Template name is required', code: 'NAME_REQUIRED' });
    }

    const template = await LoadTemplate.create({
      company: req.companyId,
      name,
      description,
      isRecurring: !!isRecurring,
      recurrence,
      ...templateData,
      createdBy: req.user.id,
      updatedBy: req.user.id,
      isDemoData: req.isDemoMode
    });

    await recordAuditEvent({ action: 'LOAD_TEMPLATE_CREATED', entityType: 'LoadTemplate', entityId: template._id, companyId: req.companyId, actor: { id: req.user.id }, summary: `Load template ${name} created`, severity: 'info' });

    return res.status(201).json({ success: true, template });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/load-templates
 * @desc    List load templates
 * @access  Authenticated
 */
router.get('/', requireAuth, requireCompanyContext, requirePermissions('VIEW_LOADS'), async (req, res, next) => {
  try {
    const { isActive = true, isRecurring } = req.query;
    const filter = { company: req.companyId };
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isRecurring !== undefined) filter.isRecurring = isRecurring === 'true';

    const templates = await LoadTemplate.find(filter).sort({ createdAt: -1 });
    return res.json({ success: true, templates });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/load-templates/:templateId
 * @desc    Get load template by ID
 * @access  Authenticated
 */
router.get('/:templateId', requireAuth, requireCompanyContext, requirePermissions('VIEW_LOADS'), async (req, res, next) => {
  try {
    const template = await LoadTemplate.findOne({ _id: req.params.templateId, company: req.companyId });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found', code: 'NOT_FOUND' });
    }
    return res.json({ success: true, template });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   PUT /api/load-templates/:templateId
 * @desc    Update load template
 * @access  Authenticated (broker)
 */
router.put('/:templateId', requireAuth, requireCompanyContext, requirePermissions('CREATE_LOAD'), async (req, res, next) => {
  try {
    const { name, description, isRecurring, recurrence, isActive, ...templateData } = req.body || {};
    
    const template = await LoadTemplate.findOneAndUpdate(
      { _id: req.params.templateId, company: req.companyId },
      { $set: { name, description, isRecurring, recurrence, isActive, ...templateData, updatedBy: req.user.id } },
      { new: true, runValidators: true }
    );

    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found', code: 'NOT_FOUND' });
    }

    await recordAuditEvent({ action: 'LOAD_TEMPLATE_UPDATED', entityType: 'LoadTemplate', entityId: template._id, companyId: req.companyId, actor: { id: req.user.id }, summary: `Load template ${template.name} updated`, severity: 'info' });

    return res.json({ success: true, template });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   DELETE /api/load-templates/:templateId
 * @desc    Delete load template
 * @access  Authenticated (broker)
 */
router.delete('/:templateId', requireAuth, requireCompanyContext, requirePermissions('CREATE_LOAD'), async (req, res, next) => {
  try {
    const template = await LoadTemplate.findOneAndDelete({ _id: req.params.templateId, company: req.companyId });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found', code: 'NOT_FOUND' });
    }

    await recordAuditEvent({ action: 'LOAD_TEMPLATE_DELETED', entityType: 'LoadTemplate', entityId: req.params.templateId, companyId: req.companyId, actor: { id: req.user.id }, summary: `Load template ${template.name} deleted`, severity: 'info' });

    return res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/load-templates/:templateId/create-load
 * @desc    Create load from template
 * @access  Authenticated (broker)
 */
router.post('/:templateId/create-load', requireAuth, requireCompanyContext, requirePermissions('CREATE_LOAD'), async (req, res, next) => {
  try {
    const { overrides = {} } = req.body || {};
    
    const template = await LoadTemplate.findOne({ _id: req.params.templateId, company: req.companyId, isActive: true });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found or inactive', code: 'NOT_FOUND' });
    }

    const loadData = await LoadTemplate.createLoadFromTemplate(template._id, overrides);
    
    // Generate load number
    const loadNumber = await NumberSequence.getNextNumber(req.companyId, 'Load', req.isDemoMode);
    loadData.loadNumber = loadNumber;
    loadData.company = req.companyId;
    loadData.createdBy = req.user.id;
    loadData.updatedBy = req.user.id;
    loadData.isDemoData = req.isDemoMode;

    const load = await Load.create(loadData);

    await recordAuditEvent({ action: 'LOAD_CREATED_FROM_TEMPLATE', entityType: 'Load', entityId: load._id, companyId: req.companyId, actor: { id: req.user.id }, summary: `Load ${loadNumber} created from template ${template.name}`, severity: 'info' });

    return res.status(201).json({ success: true, load });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
