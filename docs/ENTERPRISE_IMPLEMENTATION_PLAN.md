# FreightBrokerCMR Enterprise Implementation Plan

**Status:** Enterprise scope locked  
**Delivery target:** One-month focused delivery for a production-ready core release, followed by staged enterprise expansion  
**Applications:** Next.js web + Expo Android  
**Services:** Node.js/Express API + MongoDB  
**Repositories:**
- `SMDHussain912/FriegthBrokerCMR-Frontend`
- `SMDHussain912/FriegthBrokerCMR-Backend`
- `SMDHussain912/FriegthBrokerCMR-Mobile`

## Delivery rule

The enterprise product vision is broader than a responsible one-month release. The one-month target is a production-ready core vertical slice: secure tenant-aware brokerage accounts, carrier onboarding and compliance, load creation, eligibility, dispatch, operational history, core financial records, and usable web/Android flows. Advanced GPS, external load-board networks, AI recommendations, and deep accounting integrations remain staged expansion unless already implemented and verified.

A feature is complete only when its backend behavior, authorization, UI, tests, deployment and operational behavior are verified. A green build alone is not feature completion.

## Initial repository audit — verified observations

### Backend
- Express currently mounts health, auth, carrier and load routers in `app.js`.
- A `Company` model exists, but `app.js` does not mount a company router. The frontend data layer already calls `/api/companies`, so those calls currently have no matching mounted API route.
- `Carrier`, `Load` and `User` schemas inspected in this audit do not have a tenant/company ownership relationship.
- The user role enum is currently limited to `broker`, `compliance_officer`, and `admin`.
- Carrier listing route currently has no authentication middleware and returns full carrier documents.
- Load-specific eligibility route currently has no authentication middleware.
- Load list/detail and assignment routes require authentication, but the inspected query paths are not tenant-scoped.
- Carrier records and load records default `isDemoData` to true. Production/demo data separation and seed behavior need an explicit audit before release.
- The auth middleware validates JWTs and loads the user from MongoDB; production JWT secret checks are present.
- Backend CI workflow exists and provisions MongoDB for tests. Its current install step uses `npm install`; make lockfile-based installs consistent across repositories.

### Web
- Next.js 16.4.1 app exists and the latest known Vercel production deployment for the dashboard import fix reached READY.
- The web data layer contains company API helpers, while the backend company router is not mounted.
- Existing dashboard and load/carrier surfaces are a useful starting point, but their workflows need tenant-aware authorization and production data handling.

### Mobile
- Expo SDK 54 / React Native app exists with authentication, dashboard, load board, load creation, load details and carrier directory screens.
- A shared typed API client was added because the file was previously empty.
- A mobile CI workflow was added for TypeScript and Expo web export. Its passing result must be confirmed before treating it as a release gate.
- Mobile screens are not yet a complete carrier portal, driver app or financial workspace.

## P0 — Release blockers

1. Design and implement tenant isolation before introducing more tenant-owned features.
2. Add company onboarding and membership APIs; mount the company router and align the frontend.
3. Add tenant/company ownership to users, memberships, carriers, loads and all tenant-owned records.
4. Enforce tenant scoping in every read, update, delete, assignment and nested resource query.
5. Remove public exposure of carrier dossiers and load eligibility; use authenticated, permission-checked routes and safe response DTOs.
6. Replace the three-role model with explicit company membership roles and permission checks while preserving a controlled platform-super-admin path.
7. Define production/demo data policy; production must not expose seeded/demo records or silently create demo defaults.
8. Add migration/backfill strategy for existing records before enforcing required tenant references.
9. Add end-to-end tests proving two tenants cannot read, mutate, assign or infer each other's records.
10. Verify actual Render/Vercel/EAS configuration, secrets, database target, backups and rollback path.

## One-month delivery plan

### Week 1 — Architecture and security foundation
- Inventory all models, routes, frontend pages, mobile screens, tests and deployed environment variables.
- Define tenant ownership and membership model.
- Implement company registration/onboarding and membership lifecycle.
- Add tenant context middleware and permission service.
- Add data migration/backfill plan and safe staging test.
- Add cross-tenant isolation tests.

**Exit gate:** company membership and tenant boundaries are enforced server-side; cross-tenant tests pass.

### Week 2 — Carrier CRM and compliance
- Carrier onboarding and profile CRUD.
- Tenant-scoped carrier directory and dossier.
- Insurance policy records and document metadata.
- Compliance review permissions and audit events.
- Vetting evaluation with explicit reason codes and source freshness.
- Web carrier and compliance workflows; mobile carrier access.

**Exit gate:** a brokerage can onboard and review its own carriers without exposing another tenant's data.

### Week 3 — Loads, matching and dispatch
- Customer and load CRUD.
- Load board, filtering and status lifecycle.
- Load-specific carrier eligibility.
- Carrier offers, accept/reject and authorized direct dispatch.
- Assignment conflict handling and immutable decision snapshot.
- Notifications for core load/dispatch events.
- Web and Android end-to-end workflow.

**Exit gate:** create load → evaluate carrier → offer/accept or direct dispatch → record milestones, with audit trail.

### Week 4 — Financial core, hardening and release
- Customer invoice and carrier payable records linked to completed loads.
- Rate, charge, expense and margin calculations.
- Payment/settlement status and controlled adjustment history.
- Core financial dashboard and exports.
- Security, regression, performance and backup/restore tests.
- Android production build and release checklist.
- Production deployment, smoke tests and rollback rehearsal.

**Exit gate:** complete a demo brokerage workflow from onboarding through delivery and financial close, with passing tests and production smoke checks.

## Enterprise expansion after the one-month core release

1. Carrier portal self-service and multi-user carrier organizations.
2. Driver, truck and trailer management.
3. GPS/ELD integrations and advanced shipment visibility.
4. Automated FMCSA/insurance provider integrations.
5. Document OCR and certificate extraction.
6. Customer portal and shipper collaboration.
7. Advanced accounts receivable/payable, reconciliation and accounting integrations.
8. Advanced analytics, profitability and forecasting.
9. AI-assisted matching and risk summaries with human approval.
10. Enterprise SSO/MFA, configurable policies, retention controls and advanced audit exports.

## Definition of done

- Backend API, web app and Android app pass their CI checks.
- Tenant isolation and permission tests pass.
- No public route exposes sensitive carrier, load, document or financial information.
- Carrier onboarding and compliance review work end-to-end.
- Load creation, eligibility, offer/acceptance, assignment and delivery work end-to-end.
- Financial invoice, payable, settlement and adjustment workflows work end-to-end.
- Audit history records sensitive actions.
- Production secrets and database target are verified.
- Backups and restore procedure are tested.
- Production smoke tests and rollback procedure are documented.
- Remaining unimplemented integrations are labelled as roadmap items, not represented as live functionality.

## Working agreement for parallel development

- Keep `main` deployable; use focused feature branches and pull requests for risky schema/security work.
- One owner per feature branch; do not have two agents edit the same files concurrently.
- The human project lead owns product decisions and production approvals.
- Cline handles implementation tasks assigned from the issue/task list.
- ChatGPT handles architecture review, task decomposition, code review, test design and integration verification.
- Every task includes acceptance criteria, touched files, tests run, deployment evidence and known limitations.
