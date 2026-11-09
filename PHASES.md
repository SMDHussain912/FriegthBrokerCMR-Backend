# Backend Delivery Phases

Each phase produces reviewable artifacts. Do not start dependent work until its entry conditions are met. Mark a phase complete only with code, tests and evidence—not estimates.

## Phase 0 — Repository baseline and decisions
**Work:** inventory routes, models, middleware, scripts, CI, environment variables and deployed services; document current API contracts and data volumes.  
**Outputs:** architecture map, endpoint/model inventory, risk register, decision log, baseline test report.  
**Exit gate:** current behavior and migration risks are understood; no guessed schema assumptions remain.

## Phase 1 — Tenant and identity foundation
**Work:** define Company, Membership and tenant ownership; implement onboarding/invitations/role permissions; add tenant context and authorization services; plan and run safe backfills.  
**Outputs:** approved schema diagram, migration/backfill scripts, permission matrix, company/membership APIs, cross-tenant integration tests.  
**Exit gate:** two-company isolation tests prove users cannot read, mutate, assign or infer each other's records; legacy records have an explicit ownership disposition.

## Phase 2 — Carrier CRM and compliance
**Work:** carrier CRUD, contacts/equipment, private document metadata/storage, insurance policies, expiry states, compliance review and vetting evidence.  
**Outputs:** tenant-scoped carrier APIs, document lifecycle, review/reason codes, expiry job, audit events, API examples and tests.  
**Exit gate:** role permissions, document access, expiry and stale/unknown verification behavior pass tests.

## Phase 3 — Customers, loads and dispatch
**Work:** customer CRUD, load lifecycle, eligibility rules, carrier offers, acceptance/rejection, assignment and conflict handling.  
**Outputs:** load/customer APIs, state machine, dispatch service, idempotency/conflict strategy, assignment snapshots and audit timeline.  
**Exit gate:** end-to-end load creation through dispatch passes concurrency, authorization and tenant-isolation tests.

## Phase 4 — Financial core and reporting
**Work:** invoices, carrier payables, charges, expenses, margin, settlement status and exports.  
**Outputs:** financial schema, calculation rules, APIs, reconciliation/export tests, immutable adjustment/audit strategy.  
**Exit gate:** totals reconcile against fixtures; permissions and correction history are verified.

## Phase 5 — Notifications and integrations
**Work:** notification preferences/templates/outbox, retry and delivery tracking; provider adapters for approved integrations.  
**Outputs:** event catalog, notification worker, delivery status, provider contracts, timeout/retry/idempotency tests.  
**Exit gate:** provider outage does not corrupt core workflows; no fake success states.

## Phase 6 — Production hardening
**Work:** security review, rate limits, observability, indexes, load tests, backup/restore, secrets, deployment and rollback.  
**Outputs:** threat model, performance report, runbooks, backup/restore evidence, environment checklist, release candidate.  
**Exit gate:** staging acceptance, recovery rehearsal, CI and security tests pass.

## Phase 7 — Release and operations
**Work:** production migration, smoke tests, monitoring, incident ownership and support handoff.  
**Outputs:** release notes, migration log, deployment evidence, rollback decision, operational dashboard/runbook.  
**Exit gate:** critical workflows verified in production and no unresolved release-blocking security/data-integrity defects.

## Every phase must report
- Scope completed and deliberately deferred.
- Files/modules changed and commit/PR links.
- Schema/API changes and client impact.
- Tests run with exact results.
- Security and tenant-isolation evidence.
- Deployment/environment impact and rollback steps.
- Known defects, risks, owner and next-phase dependencies.

**Rule:** one-month delivery targets the secure production core; advanced GPS, load-board, OCR, accounting and AI integrations remain separate phases unless explicitly approved and verifiably implemented.
