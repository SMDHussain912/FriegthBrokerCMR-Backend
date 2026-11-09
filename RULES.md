# Backend Engineering Rules

These rules apply to every change in FreightBrokerCMR Backend. The API is the security and business-rule boundary for web and mobile.

## Required stack
- Runtime: supported Node.js LTS matching CI and deployment.
- HTTP: existing Express application and router structure.
- Language: preserve the repository's current JavaScript conventions; introduce TypeScript only through an approved migration, not piecemeal.
- Database: existing MongoDB/Mongoose models and indexes.
- Validation: use the repository's established validation library if present; otherwise propose one before adding it. Validate params, query and body at route boundaries.
- Tests: existing test runner and MongoDB test service; add integration tests for every protected workflow.
- CI: lockfile-based `npm ci`; do not bypass CI checks.

## Architecture rules
1. Keep routes thin: authentication, validation, permission checks, service call, response.
2. Put business logic in services; keep persistence queries in repositories/models or clearly separated service methods.
3. Centralize tenant resolution and permission checks. Never trust companyId supplied by a client without verifying membership.
4. Tenant-scope every query, update, delete, aggregate, populate, export, background job and nested resource lookup.
5. Use safe response DTOs. Never serialize full user, carrier, document or credential records by default.
6. Add indexes for tenant-scoped access patterns and verify query plans for large collections.
7. Use explicit state-transition functions; reject invalid transitions.
8. Record audit events for authentication/security-sensitive events, membership changes, compliance decisions, load status/assignment and financial mutations.
9. Use transactions or compensating workflows where multi-document consistency requires them; document MongoDB deployment requirements.
10. Keep external providers behind adapters with timeouts, retries, idempotency and clear unavailable/unknown states.

## Security — must do
- Authenticate all non-public business routes.
- Authorize at resource and tenant level on every request.
- Use least-privilege role permissions; platform administration is distinct from tenant roles.
- Hash passwords with the established secure password-hashing implementation.
- Keep JWT/session secrets and provider credentials in deployment secrets, never source code.
- Validate and normalize all external input; prevent mass assignment by allowlisting writable fields.
- Apply rate limits to login, registration, invitations and expensive endpoints.
- Use safe CORS, security headers, bounded request sizes and generic production errors.
- Protect uploads: type/size validation, private storage, malware scanning strategy and signed access where applicable.
- Never expose tokens, secrets, private documents or stack traces in logs/responses.

## Must not do
- Do not add public carrier dossiers, eligibility endpoints or tenant data endpoints.
- Do not query by record ID alone when the record is tenant-owned.
- Do not accept role, tenantId, ownership or approval status blindly from request bodies.
- Do not use demo defaults or seed data in production.
- Do not silently overwrite compliance or financial history.
- Do not claim an external check succeeded when provider data is missing, stale or unavailable.
- Do not add dependencies without checking maintenance, license, security and bundle/runtime impact.
- Do not commit secrets, local environment files, database dumps or real customer data.
- Do not disable tests, lint, validation or authorization to make a pipeline green.

## API conventions
- Keep resource naming and response/error shapes consistent with existing API contracts.
- Paginate list endpoints; cap page size and sort/filter options.
- Return appropriate HTTP status codes and stable machine-readable error codes.
- Make retryable mutations idempotent where duplicate execution could cause harm.
- Document breaking changes and coordinate contract changes with web and mobile.

## Required tests for each feature
- Happy path and validation failures.
- Unauthenticated and insufficient-permission cases.
- Cross-tenant read and mutation denial.
- Not-found behavior that does not disclose another tenant's record.
- State transition and concurrency/conflict cases.
- Audit event assertions for sensitive mutations.
- Regression tests for affected routes.

## Completion checklist
- [ ] Tenant and permission enforcement reviewed.
- [ ] Validation and safe DTOs implemented.
- [ ] Indexes/migration/backfill reviewed.
- [ ] Unit and integration tests pass.
- [ ] API contract documented and clients notified.
- [ ] Logs/metrics avoid sensitive data.
- [ ] CI and staging smoke tests pass.
- [ ] Rollback/recovery impact documented.
