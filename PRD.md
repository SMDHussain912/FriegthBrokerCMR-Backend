# FreightBrokerCMR — Product Requirements Document

**Status:** Working product baseline; implementation status must be verified in code  
**Product:** Multi-tenant freight brokerage operations platform  
**Clients:** Web, Android/iOS mobile  
**Backend:** Node.js, Express, MongoDB

## 1. Product vision
FreightBrokerCMR helps freight brokerages manage customers, carriers, compliance, loads, dispatch, operational communication and financial records in one secure workspace. It must behave as a dependable multi-company SaaS product, not a demo dashboard.

## 2. Goals
- Isolate every brokerage's data and actions by tenant.
- Maintain a reliable carrier directory and auditable compliance records.
- Create, track, match and dispatch loads through explicit lifecycle states.
- Give staff role-appropriate access from web and mobile.
- Preserve a traceable history of important operational and financial changes.
- Provide dependable APIs, observability, backups and release controls.

## 3. Users and permissions
- **Platform administrator:** platform-level operations; access must be exceptional, audited and separate from tenant membership.
- **Company owner/admin:** company settings, invitations, memberships and role assignment.
- **Broker/dispatcher:** customer and load operations, carrier selection, offers and dispatch.
- **Compliance officer:** carrier documents, insurance, verification, review decisions and expiry follow-up.
- **Finance user:** invoices, carrier payables, charges, expenses, settlements and exports.
- **Read-only/auditor:** explicitly granted read access and audit history.
Permissions must be enforced by the API. Hiding a button is not authorization.

## 4. Core product modules
1. Identity, authentication, company onboarding and memberships.
2. Tenant-aware company settings and user management.
3. Carrier CRM: profiles, contacts, equipment, status, notes and documents.
4. Compliance: insurance policies, document metadata, expiry, verification status, review decisions and evidence.
5. Customer management.
6. Load management: creation, editing, lifecycle, pickup/delivery details and status history.
7. Carrier eligibility and vetting with reason codes, source and checked-at timestamps.
8. Dispatch: offers, acceptance/rejection, assignment, conflict prevention and assignment history.
9. Notifications and activity/audit timeline.
10. Financial core: invoices, payables, accessorial charges, expenses, margin and settlement status.
11. Reporting, exports and operational dashboards.
12. Platform operations: health, logs, metrics, backup/restore and deployment controls.

## 5. Critical business rules
- Every tenant-owned record must carry a trusted company/tenant reference.
- Tenant context comes from the authenticated membership, never from an untrusted request body alone.
- Every read, write, nested lookup, search, export and background job must enforce tenant scope.
- Carrier eligibility is a decision record with reasons and freshness; it is not a guarantee of legal or regulatory compliance.
- A load may have only valid, conflict-free active assignments under the defined dispatch policy.
- State transitions must be explicit, validated server-side and recorded in history.
- Financial records must retain amounts, currency, references, status and immutable audit events; corrections use adjustments rather than silent history rewrites.
- Demo/seed data must never leak into production customer workspaces.

## 6. Non-functional requirements
- Security: secure sessions, least privilege, input validation, rate limits, safe errors, secret management and auditability.
- Isolation: automated cross-tenant access tests for all tenant-owned resources.
- Reliability: health/readiness checks, structured logs, actionable error reporting and documented recovery.
- Performance: pagination and bounded queries for collections; indexes for tenant and common filter fields.
- Accessibility/usability: responsive web UI, mobile-friendly workflows, clear empty/loading/error states.
- Maintainability: typed contracts where applicable, modular services, migration documentation and repeatable CI.

## 7. Integrations and staged scope
The core must use provider adapters for external services. FMCSA/safety data, insurance verification, load boards, GPS/ELD, OCR, accounting, SSO/MFA and AI matching are staged integrations unless a specific provider, credentials, legal basis and acceptance tests are approved. Never simulate a successful external verification.

## 8. Out of scope for the core release
- Claiming regulatory certification or guaranteed carrier safety.
- Unverified live integrations represented as production data.
- Autonomous AI decisions that dispatch loads or approve compliance without human authorization.
- Full driver/shipper portals and advanced fleet telematics until core tenant isolation and workflows are stable.

## 9. Success measures
- Cross-tenant access tests pass with zero leakage.
- Core carrier-to-load-to-dispatch workflow completes on web and mobile.
- Compliance review and expiry states are auditable.
- Financial records reconcile to source transactions and exports.
- CI, staging smoke tests, backup/restore rehearsal and rollback procedure pass.

## 10. Acceptance criteria
A feature is done only when API validation and authorization, persistence, UI integration, automated tests, audit behavior, error/loading/empty states, documentation and deployment evidence are complete. A green build alone is not feature completion.

## 11. Backend repository responsibilities
Own authentication and authorization, tenant context, domain models, validation, business rules, persistence, migrations/backfills, audit events, notifications, integrations/adapters, API contracts, tests and operational endpoints. Web and mobile clients must not duplicate authoritative business rules.

## 12. Open decisions
Record decisions for tenant ownership/membership schema, role-permission matrix, carrier vetting sources, load state machine, dispatch policy, currency/timezone policy, retention, notification providers and financial accounting rules before implementation depends on them.
