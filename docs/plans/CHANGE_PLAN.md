# AidLink Change Plan switching devices set up automatic download series for the discover with crading. Try one free

This document arranges the requested changes into independent prompts. Implement them one at a time. Do not release the application until the relevant change has been tested and approved.

## Project Context

AidLink has two applications:

- Mobile app: Flutter requestor application.
- Website: React/Vite/Express staff portal and API.

Recommended staff roles:

- **Case Worker:** reviews and processes assistance requests.
- **System Administrator:** manages users, roles, settings, audit logs, and reports.
- **Super Admin:** optional platform-level role only if required.

## Prompt 1: Protect Request History

Fix the mobile app so one applicant cannot see another applicant's previous requests on the same device.

Requirements:

- Store cached applications using the authenticated applicant's stable ID.
- Clear cached requests and applicant data when the user logs out.
- Clear or replace cached data when another account logs in.
- Ensure server history is always filtered by the authenticated applicant token.
- Verify that changing an applicant ID or email cannot expose another applicant's request.
- Add tests for two accounts using the same device.

## Prompt 2: Update Assistance Types

Update the mobile app, backend, and website to use one canonical list of assistance types.

Remove:

- Medicine Assistance
- Other Assistance

Before implementation, confirm the final remaining list with the client because the current mobile and website lists are different. The backend must validate assistance types instead of relying only on mobile or website controls.

## Prompt 3: Remove PhilHealth

Remove PhilHealth from the applicant workflow.

Requirements:

- Remove the PhilHealth toggle and PhilHealth number from the mobile form.
- Remove PhilHealth from the review screen.
- Remove PhilHealth from the mobile data model and submission payload.
- Stop requiring PhilHealth for new requests.
- Keep old stored records readable if they already contain PhilHealth data.
- Do not display old PhilHealth data unless necessary for authorized migration or audit purposes.

## Prompt 4: Replace the Reason Field With a Survey

Remove the free-text “Reason for requesting assistance” field.

Replace it with two structured questions:

1. What is the source of income of the patient or household?
2. What happened to the patient?

Suggested answer categories for the second question:

- Accident
- Disease
- Existing health issue
- Injury
- Other client-approved category

Requirements:

- Confirm exact choices with the client.
- Store answers as structured application data.
- Display answers to the Case Worker.
- Keep an optional details field only if the client needs additional explanation.
- Preserve old reason values for existing applications.

## Prompt 5: Remove Medicine Assistance

Remove Medicine Assistance from all new request flows.

Requirements:

- Remove it from the mobile assistance-type screen.
- Reject it in backend validation for new applications.
- Remove medicine-specific required documents from new-request configuration.
- Preserve existing medicine requests for historical records and processing.
- Display a clear message if an old medicine request is opened.

## Prompt 6: Block Poor-Quality Documents

Prevent applicants from submitting documents that are unreadable or technically poor quality.

Block submission for:

- Excessive blur
- Very low brightness
- Excessive glare
- Unreadable dimensions or resolution
- Corrupt file contents
- Unsupported file format
- Severe cropping or incomplete boundaries

Requirements:

- Run document analysis before final submission.
- Show the applicant the exact problem and how to fix it.
- Require replacement of failed documents.
- Allow accepted documents with non-blocking guidance warnings.
- Store the analysis result, warnings, orientation, analyzer version, and timestamp.
- Do not claim that quality analysis verifies authenticity.

## Prompt 7: Add Document Replacement Under Review

Allow applicants to replace documents after a Case Worker requests corrections.

Recommended flow:

1. Case Worker opens the request.
2. Case Worker changes the status to `Correction Requested` or `Under Review` with correction requirements.
3. Case Worker selects documents that must be replaced and enters a clear remark.
4. Applicant receives an in-app notification.
5. Applicant opens the request and replaces only the requested documents.
6. Each replacement goes through the document quality check.
7. Applicant submits the corrections.
8. The request returns to `Under Review`.
9. Previous documents, remarks, replacements, and users remain in the audit history.

Applicants must only be able to replace files belonging to their own requests.

## Prompt 8: Remove Website Registration

Remove public staff registration from the website.

Requirements:

- Remove the registration link and registration screen from the login flow.
- Disable public staff registration in the backend.
- Allow only an authorized System Administrator to create staff accounts.
- Allow administrators to deactivate accounts, reset passwords, and assign roles.
- Do not rely on hidden buttons as the only security control.

## Prompt 9: Introduce Case Worker and System Administrator Roles

Separate request processing from system administration.

Case Worker permissions:

- View assigned or permitted requests.
- Review documents.
- Request corrections.
- Assign facilities.
- Approve or deny requests.
- View relevant request history and audit information.

System Administrator permissions:

- Create, deactivate, and manage staff accounts.
- Assign and change roles.
- Configure assistance types and required documents.
- Manage system settings.
- View audit logs and system activity.
- Generate reports.

Use backend permission checks for every protected endpoint. Do not rely only on frontend visibility.

## Prompt 10: Remove Guarantee-Letter Uploading

Remove guarantee-letter uploading from the website workflow.

Before implementation, confirm whether the guarantee letter is completely removed from the business process or still produced externally but no longer uploaded by staff. If it remains part of the process, store only the necessary claim reference, schedule, and status instead of requiring a staff upload. Preserve existing guarantee-letter metadata so historical approved requests remain readable.

## Prompt 11: Improve the Central Dashboard

Make the central dashboard focus on incoming applications and work queues.

Display separate queues for:

- New or pending applications
- Under review
- Correction requested
- Approved for claiming
- Denied
- Overdue or stale applications

Requirements:

- Show counts and the newest applications.
- Allow Case Workers to open the relevant queue quickly.
- Keep dashboard counts consistent with the request table and analytics.
- Add filters for date, assistance type, facility, and status.

## Prompt 12: Add Audit Logs and System Activity

Create an administrator-only activity view.

Record and display:

- Login and logout events
- Account creation, deactivation, and role changes
- Request status changes
- Document uploads and replacements
- Correction requests
- Facility and system-setting changes
- Report generation and exports
- MFA enrollment and recovery events

Each record should include the actor, action, affected record, timestamp, and relevant details.

## Prompt 12A: Clarify Admin System Settings and Applicant Verification

Clarify the purpose of the admin system configuration page and the required-documents-by-assistance-type setup so administrators understand how it drives the actual workflow.

Requirements:

- Explain what "System Settings" are used for in the application, including how they affect request processing, workflow rules, validation, notifications, and system behavior.
- Explain what "Required Documents by Assistance Type" means and how it is used during application intake, review, and approval.
- Add clear help text, labels, descriptions, or explanatory panels in the admin system settings screen so a System Administrator understands the purpose of each config without needing code-level knowledge.
- Show how each assistance type is mapped to required supporting documents, and explain that this configuration is used to enforce the correct document checklist for each request.
- Keep the configuration page focused on business rules and workflow controls rather than purely display preferences.
- Remove the concept of "accredited facilities" from the admin model and request workflow unless a separate client-approved accreditation process is introduced later.
- Replace the static accredited-facility model with receipt-based facility identification, where the requestor can provide supporting proof from the hospital, pharmacy, or other facility tied to the assistance request, and the system validates those documents based on the receipt content, document quality, and request context.
- Allow the system to accept recent valid supporting receipts while rejecting outdated or stale ones, such as receipts from many years ago that no longer match the current assistance request.
- Require a valid government-issued ID upload from newly registered applicants before their account is marked as fully verified.
- On registration, create the applicant account in a basic or unverified state, with limited access until ID verification is completed.
- Add a verification flow for applicant identity proof that allows the applicant to upload a valid ID and for a System Administrator to approve or reject it.
- Restrict applicant ID verification approval to authorized System Administrators only; reviewers may view, flag, or escalate the submission but may not approve the final verification decision.
- Store verification status, uploaded ID metadata, approving administrator, decision timestamp, and audit notes for each applicant account.
- Prevent unverified accounts from accessing full applicant features until verification is approved.
- Add audit log entries for applicant ID upload, administrator approval, rejection, and account status changes.
- Keep the verification requirement aligned with the client’s expected trust and fraud-control standards, similar to common e-wallet or digital wallet identity checks.

## Prompt 13: Add Approval SMS Notifications

Create a provider-neutral SMS notification service for approved requests.

The SMS should include:

- Applicant name or request reference
- Approval confirmation
- Claiming date, time, and location
- Reminder to bring a valid government-issued ID
- Requirement for an authorization letter if another person claims the assistance
- Required ID of the authorized representative
- Contact number or help channel
- Reminder not to share passwords or OTPs

Add delivery status, retry handling, and notification audit records. Select the SMS provider later through an adapter rather than coupling the application to one vendor.

## Prompt 14: Add Applicant Two-Factor Authentication

Add stronger authentication for applicants.

Recommended design:

- TOTP authenticator app as the primary MFA method.
- SMS OTP as recovery or accessibility fallback.
- Step-up verification for changing phone number, email, password, or recovery settings.
- Recovery codes stored securely and shown only once.
- Audit MFA enrollment, verification, failure, and recovery events.

## Prompt 15: Prepare AI-Ready Document Analysis

Keep document analysis behind a replaceable analyzer interface.

Current deterministic checks should handle blur, brightness, glare, cropping, file validity, basic document boundaries, and portrait or landscape orientation.

A future AI analyzer may:

- Classify document type.
- Detect missing pages.
- Detect likely unreadable text.
- Estimate confidence.
- Explain why a document was flagged.

AI must not make final authenticity or eligibility decisions. Low-confidence results should be routed to a human Case Worker. Minimize image retention and protect uploaded documents.

## Prompt 16: Add Administrative and Analytical Reports

Add role-protected reporting for System Administrators.

Initial reports should include:

- Applications by date
- Applications by assistance type
- Approval and denial rates
- Correction rates
- Average processing time
- Facility workload
- Document failure reasons
- Active users and staff activity
- Audit activity

Requirements:

- Support date, status, assistance type, and facility filters.
- Provide CSV and PDF export where practical.
- Include generated timestamp and report parameters.
- Record report generation and exports in the audit log.

## Prompt 17: Add Protected Guarantee Letter Delivery

Add a staff-controlled guarantee-letter workflow for approved requests.

Required flow:

1. A Case Worker opens a request that is ready for approval.
2. Before approving the request, the Case Worker uploads the guarantee-letter file.
3. Accept Microsoft Word and PDF uploads. Convert Word files to PDF on the server using a free, supported office conversion tool such as LibreOffice.
4. Allow the Case Worker to review the converted PDF before approval.
5. Do not allow approval until a valid guarantee letter has been uploaded and confirmed.
6. When the request and letter are approved, generate a secure QR token for that letter.
7. Show the requestor that the request is approved and provide the QR code.
8. When scanned, the QR code must open a protected AidLink viewing page for the approved letter.
9. The requestor may view the PDF but must not receive a download or print control in AidLink.
10. Preserve the original uploaded Word file privately and expose only the protected PDF viewer to the requestor.

Requirements:

- Store the letter against the request with its file type, conversion status, version, uploader, upload timestamp, approval timestamp, and audit history.
- Keep the original Word file inaccessible to requestors.
- Serve the PDF through authenticated or expiring access rather than a public file URL.
- Add visible view-only watermarks and apply PDF print restrictions where practical.
- Do not claim that screenshots, photographs, browser tools, or other copying methods can be completely prevented.
- Generate the requestor QR only after the letter and request have been approved.
- Revoke the previous QR when staff replaces, corrects, or revokes the approved letter, then issue a new token for the current version.
- Record letter upload, conversion, review, approval, QR generation, QR scans, replacement, revocation, and access events in the audit log.
- Show a clear status when a letter is pending, unavailable, expired, revoked, or replaced.
- Treat this as an AidLink protected-letter QR unless the client provides an integration or specification proving that AidLink can generate the official QR from the client system.
- Do not invent or label an AidLink document as the client’s official guarantee-letter template without client approval.

Testing requirements:

- Test valid PDF upload and protected viewing.
- Test Word-to-PDF conversion and conversion failure handling.
- Test that approval is blocked without a valid letter.
- Test that requestors cannot download the original Word file or access a public PDF URL.
- Test QR access for the correct request and rejection of expired, revoked, or replaced tokens.
- Test role permissions, audit records, and letter replacement behavior.

## Prompt 18: Fix Applicant Verification Session Handling

Fix the System Administrator applicant-verification workflow on the website.

Requirements:

- Clicking "Open identity proof" must open the protected identity document without logging the administrator out.
- Preserve the authenticated administrator session while opening, previewing, and closing the identity proof.
- Use the existing authenticated document-access pattern consistently for identity-proof files.
- Handle expired sessions and unauthorized document access with a clear error instead of silently logging out.
- Show an actionable message when the identity proof cannot be opened, including whether the file is missing, expired, unauthorized, or unavailable.
- Keep identity-proof access restricted to authorized System Administrators.
- Record identity-proof access failures in the audit log where appropriate.

Testing requirements:

- Test opening identity proof from the verification panel without losing the session.
- Test preview and close behavior, expired sessions, missing files, and unauthorized access.

## Prompt 19: Repair the Request Correction Workflow

Fix the website workflow for requesting corrections on assistance requests.

Requirements:

- A Case Worker can select one or more documents that need replacement.
- Require a correction remark that clearly explains what the applicant must fix.
- Make the correction action work for both pending and under-review requests where permitted.
- Show validation feedback when no document is selected or the correction remark is missing.
- Change the request to `correction_requested` only after the correction request is successfully saved.
- Show the selected documents, remark, requester, and timestamp in the request details.
- Ensure the requestor can see which documents need replacement and submit only those replacements.
- Return the request to `under_review` after the requested replacements are submitted.
- Preserve previous files and correction events in the audit history.

Testing requirements:

- Test correction requests with one document and multiple documents.
- Test missing-document and missing-remark validation.
- Test replacement submission and return to under review.
- Test that unrelated documents cannot be replaced through the correction flow.

## Prompt 20: Clarify the Request Approval Workflow

Redesign the website request-review workflow so staff actions happen in the correct order.

This prompt supersedes Prompt 17 wherever the ordering of approval, claiming details, and guarantee-letter upload conflicts.

Required flow:

1. Case Worker opens a pending request.
2. Case Worker reviews the applicant details, circumstances, receipt evidence, and supporting documents.
3. Case Worker may mark the request `under_review` while investigation is still in progress.
4. Case Worker may request corrections when specific documents or information are incomplete.
5. Case Worker enters required remarks before changing a decision status.
6. Case Worker approves or denies the request after review is complete.
7. Only after approval does the workflow show Step 2: claiming preparation.
8. In Step 2, authorized staff records the claiming details and uploads or attaches the guarantee letter.
9. The requestor receives the approved status and protected guarantee-letter access only after the guarantee letter is available.

Requirements:

- Do not show claiming-date, claiming-time, claiming-location, or guarantee-letter fields as required during `under_review`.
- Do not ask staff to upload a guarantee letter for a request that is still being reviewed.
- Keep `under_review`, `correction_requested`, `approved`, `denied`, and `ready_for_claiming` states visually distinct and explain the next available action.
- Make the approval action separate from claiming preparation.
- Prevent claiming preparation for denied, pending, or correction-requested requests.
- Allow staff to save Step 2 progressively without changing the request back to a review state.
- Generate the protected guarantee-letter QR only after the letter and claiming details are complete and approved for release.
- Show a clear progress indicator such as `Step 1: Review decision` and `Step 2: Prepare claiming`.

Testing requirements:

- Test pending to under review, under review to correction requested, under review to approved, and under review to denied.
- Test that claiming fields are not required while under review.
- Test that Step 2 appears only after approval.
- Test incomplete claiming preparation and final protected-letter release.

## Prompt 21: Add Actionable UI Validation and Error Feedback

Improve website feedback when an action or button cannot be completed.

Requirements:

- Every protected action must show a visible success, loading, or error state.
- When an action is blocked, identify the exact missing field, missing selection, permission, or invalid state.
- Replace silent failures and disabled-looking buttons with accessible messages or confirmation dialogs where appropriate.
- Keep the user-entered values after a failed submission so staff can correct them without starting over.
- Prevent duplicate submissions while an action is processing.
- Show server errors in plain language without exposing sensitive implementation details.
- Ensure dialogs can be closed, are keyboard accessible, and do not trap the user after an error.
- Apply this feedback consistently to approval, denial, correction requests, document access, uploads, staff actions, and configuration actions.

Testing requirements:

- Test each major request action with missing and invalid fields.
- Test network failure, permission failure, expired session, and duplicate-click behavior.
- Test keyboard and screen-reader accessible error feedback.

## Prompt 22: Add Assistance Subject Selection

Update the applicant assistance-request form to clarify who the assistance is for.

Use the labels `For myself` and `For someone else` unless the client approves clearer local-language labels.

Required flow:

1. The applicant selects `For myself` or `For someone else` before entering personal details.
2. `For myself` automatically fills the patient or beneficiary details from the authenticated applicant profile.
3. The applicant may review and correct allowed details before continuing.
4. `For someone else` shows the required fields and allows the applicant to enter the other person's details manually.

Requirements:

- Clearly label whose information is being requested.
- Never overwrite manually entered details when switching modes without confirmation.
- Validate required name, birthdate, address, and other client-approved fields.
- Keep the authenticated applicant as the requester even when the assistance is for someone else.
- Store whether the request is for the applicant or another person.
- Display the beneficiary details correctly on the review screen and to authorized staff.
- Do not copy applicant profile data into a request for someone else.

Testing requirements:

- Test both choices, profile autofill, manual entry, switching choices, validation, and submission.
- Test that the requester identity and beneficiary identity remain separate.

## Prompt 23: Simplify Receipt Reference Guidance

Remove the unnecessary technical explanation from the applicant request form.

Requirements:

- Under `Receipt or transaction reference`, remove the text explaining that AidLink checks receipt recency, request context, and technical quality.
- Keep a concise field label and useful instruction only if the client requires one.
- Do not remove backend receipt validation or staff-facing receipt evidence details.
- Keep the form understandable without exposing internal validation implementation.

Testing requirements:

- Confirm the text is absent from the applicant form and receipt submission still works.

## Prompt 24: Fix Duplicate Request Display

Fix the applicant request page when one submitted assistance request appears twice.

Requirements:

- Identify whether duplication comes from repeated API results, local caching, pagination merging, refresh logic, or duplicate submission.
- Display each request once using a stable request ID as the deduplication key.
- Keep the newest valid request data when duplicate records have the same ID.
- Do not hide genuinely different requests that share similar details.
- Prevent a repeated tap or retry from creating a second request submission.
- Keep loading, refresh, empty, and error states correct after deduplication.

Testing requirements:

- Test duplicate API records, refresh, pagination, offline cache restoration, and repeated submission taps.
- Test that two legitimate requests remain visible separately.

## Prompt 25: Reduce Excessive System Explanations in the UI

Simplify the applicant mobile app and staff website by removing unnecessary explanations about internal system flow.

Requirements:

- Remove technical or internal process explanations that do not help the user complete the current task.
- Keep essential instructions, required-field guidance, status explanations, warnings, and next steps.
- Use short, plain-language labels and contextual help near the relevant action.
- Do not expose implementation details such as internal validation algorithms, backend processing, token mechanics, or audit implementation to ordinary users.
- Preserve transparency where it affects user decisions, such as why a document was rejected or what the applicant must correct.
- Keep staff-only operational details visible only to authorized staff when needed for their work.
- Review both the applicant mobile screens and staff website screens for duplicated or overly long workflow descriptions.

Testing requirements:

- Review the main applicant and staff workflows for clarity and task completion.
- Confirm that removing explanatory text does not remove required instructions or accessibility labels.

## Prompt 26: Add the Database and Persistence Layer

Introduce the production-ready database foundation before implementing the policy workflow.

Requirements:

- Use PostgreSQL for persistent storage while keeping the current JSON data readable during migration and local development.
- Define migrations and relationships for applicants, beneficiaries, staff, requests, documents, document analysis, corrections, facilities, policy configurations, coverage decisions, budgets, Guarantee Letters, notifications, and audit logs.
- Add repository or service interfaces so request and policy code does not depend directly on JSON files or SQL queries.
- Preserve stable IDs and existing records when migrating from JSON.
- Store policy versions and decision snapshots with each affected request so historical decisions remain reproducible.
- Use transactions for request submission, document replacement, approval, budget reservation, Guarantee Letter release or expiry, and audit-log writes.
- Add unique constraints or idempotency keys for request submissions, document replacements, budget reservations, and notification delivery.
- Store audit logs as append-only records containing actor ID, timestamp, action type, affected record, old value, new value, and justification.
- Keep uploaded files in private file or object storage; store only secure metadata and references in the database.
- Add environment-based database configuration, connection handling, health checks, and a safe startup migration process.
- Do not expose database credentials or sensitive document contents in logs.

Migration requirements:

- Create a repeatable migration script from the existing JSON data.
- Make the migration idempotent and produce a report for skipped, invalid, or duplicate records.
- Keep legacy JSON as a read-only backup until the migrated data is verified.
- Test rollback or recovery behavior before changing the application’s default storage.

Testing: migrations on a copy of the current data, legacy-record reads, repository behavior, transaction rollback, concurrent budget updates, idempotent submissions, audit immutability, health checks, and application startup with an empty database.

## Prompt 27: Create the Policy Workflow Foundation

Create the shared backend foundation for the Citizen Portal, Case Worker Dashboard, Super Admin Panel, and district satellite offices.

Requirements:

- Keep eligibility, coverage, expiry, and budget decisions on the backend; the frontend only displays results and collects evidence.
- Add versioned policy configuration with `policyVersion`, effective date, actor, old value, new value, and justification.
- Add request metadata for `originatingOfficeId`, `policyVersion`, `policyFindings`, `requiredReviews`, and a decision snapshot while keeping legacy records readable.
- Define typed reason codes and a policy-evaluation service interface without enabling new blocking rules yet.
- Enforce permissions for Citizen, Case Worker, System Administrator, and Super Admin operations on the backend.
- Add audit events for policy evaluation and configuration changes.

Testing: schema migration, legacy-record reads, role permissions, policy-version persistence, and audit records.

## Prompt 28: Add Intake, Residency, Document-Year, and Cooldown Validation

Implement the first policy gates before facility or coverage calculations.

Requirements:

- Validate authenticated applicant ownership and beneficiary relationship.
- Record the originating district satellite office and validate residency using configured boundaries.
- Allow an authorized staff override only with a mandatory reason and audit entry.
- Enforce required documents, document quality results, receipt context, and the active calendar-year rule.
- Treat a January document requested in December as eligible; expire a prior-year document after the year boundary.
- Add duplicate-submission and per-patient cooldown checks. Return the existing request reference and cooldown end date instead of creating a duplicate.
- Return structured results such as `correction_required`, `human_review_required`, or `blocked`, without changing final approval status.

Testing: ownership, boundary addresses, satellite offices, year transitions, missing or poor documents, duplicate submissions, cooldown expiry, and concurrent submissions.

## Prompt 29: Implement Facility Directory, Hospital Tiers, and Prescription Routing

Implement validated facility classification and private-prescription routing.

Requirements:

- Configure a `public` tier for SPMC and district health units.
- Configure a `private` tier for the 42 accredited partners only after the client supplies the authoritative list and effective dates.
- Resolve facility and tier from validated receipt or facility evidence; never trust a client-supplied tier.
- Allow human review when evidence cannot resolve a facility.
- Require prescriptions from private clinics or doctors to pass City Health Office validation before partner-pharmacy pricing is unlocked.
- Keep hospital and pharmacy changes versioned and auditable.

Testing: public/private resolution, unknown facilities, stale evidence, CHO approval and rejection, pricing lock/unlock, and directory permissions.

## Prompt 30: Add Civic Ordinance and Hard-Rejection Rules

Implement hard disqualifiers as separate, explainable server-side rules.

Requirements:

- Apply the no-helmet rule to motorcycle accident claims and require the police or traffic accident report.
- Apply the DUI or dangerous-drug impairment rule.
- Apply the active-crime-offense rule only when supported by authorized evidence.
- Implement any armed-group restriction only after client and legal approval, using an authorized documented decision process. Do not infer sensitive attributes from documents or automate a sensitive classification.
- Evaluate hard rejections before partial coverage calculations.
- Block ordinary Case Worker overrides. A permitted exception requires Super Admin permission, evidence, justification, and an immutable audit entry.
- Return machine-readable reason codes and plain-language messages.

Testing: each rule, missing evidence, false-positive prevention, role restrictions, exception auditing, and approval blocking.

## Prompt 31: Implement Coverage Exceptions and Payer-of-Last-Resort Calculation

Implement the coverage matrix after Prompt 29 has established that the request is not disqualified.

Requirements:

- Support public-hospital coverage reductions for upgraded private or semi-private rooms.
- Support reductions for non-formulary or branded medicines bought from unaccredited outside pharmacies.
- Support the scaled subsidy matrix for partially indigent households.
- Calculate the net remaining balance only after verified payer deductions, policy caps, and coverage rules are applied.
- Represent results as `eligible`, `partially_covered`, or `ineligible` with explainable adjustments.
- Do not add the old PhilHealth applicant toggle or number field. Confirm whether PhilHealth is an internal verified deduction supplied by staff/integration, or replace it with client-approved payer data before enabling that deduction.

Testing: each reduction, combined reductions, zero or negative balance, missing payer data, caps, and reproducible calculation snapshots.

## Prompt 32: Add Policy Evaluation API and Case Worker Review Flow

Connect the policy service to the staff workflow without combining evaluation and approval.

Requirements:

- Add an authenticated evaluation endpoint that returns findings, required evidence, coverage, reason codes, policy version, and human-review flags.
- Add Case Worker controls to review evidence, confirm coverage, request corrections, and enter mandatory remarks.
- Keep `under_review`, `correction_requested`, `approved`, `denied`, and `ready_for_claiming` aligned with Prompts 19 and 20.
- Re-evaluate before approval and return changed requests to human review when documents, policy version, deductions, or budget changed.
- Do not permit an evaluation result alone to approve a request.

Testing: endpoint ownership, role permissions, correction flow, changed-input re-evaluation, mandatory remarks, and approval sequencing.

## Prompt 33: Add Budget Pools, Guarantee Letter Expiry, and Fund Return

Connect approved assistance to controlled city budget allocation.

Requirements:

- Configure budget pools, assistance limits, depletion thresholds, and effective dates.
- Block new eligible submissions when the applicable budget is depleted with an actionable reason.
- Reserve funds atomically when an approved Guarantee Letter is released.
- Support a strict configurable Guarantee Letter validity window from 3 to 14 days.
- Expire letters server-side, return unused allocations to the active budget pool, and record the release.
- Recheck budget immediately before release and prevent concurrent approvals from overspending.

Testing: depletion, concurrent reservations, failed release retries, 3-day and 14-day expiry boundaries, fund return, and audit completeness.

## Prompt 34: Add Super Admin Policy Configuration and Immutable Audit Review

Implement the administration surface for safely operating the policy workflow.

Requirements:

- Add configuration screens for thresholds, coverage matrices, directories, residency, cooldowns, document-year rules, prescription routing, and budgets.
- Require effective dates, confirmation, justification, and policy-version publication.
- Prevent ordinary Case Workers from changing policy, tariffs, budgets, or hard-rejection rules.
- Display evaluation, override, tariff, threshold, budget, deduction, and Guarantee Letter expiry events in the administrator activity ledger.
- Include actor ID, timestamp, action type, record ID, old value, new value, and justification.
- Keep historical requests tied to their recorded policy version unless an authorized re-evaluation is created.

Testing: administrator permissions, configuration validation, version publishing, historical reproducibility, tamper-resistant audit records, and report filters.

## Prompt 35: Integrate Applicant Messaging and Controlled Rollout

Expose policy outcomes to applicants and enable the rules incrementally.

Requirements:

- Add plain-language applicant messages for correction required, human review, cooldown, partial coverage, ineligibility, budget block, and expired Guarantee Letter.
- Do not expose internal algorithms, sensitive audit details, or unsupported accusations.
- Integrate applicant status, correction, notification, and protected-letter views with the Flutter app after the backend and website are stable.
- Run all new policy rules in report-only mode first and compare them with Case Worker decisions.
- Obtain client approval for thresholds, hospital lists, coverage reductions, hard-rejection rules, payer deductions, and budget behavior before enabling blocking.
- Enable rules one at a time with rollback or disable configuration and monitor audit and error results.

Testing: mobile and website message rendering, accessibility, notification delivery, report-only comparison, rollback, and end-to-end request scenarios.

## Testing Order

1. Run Flutter tests for account isolation, document analysis, form submission, and correction uploads.
2. Run backend API checks for authentication, request ownership, roles, assistance validation, document quality gates, and correction authorization.
3. Run the website build.
4. Manually verify Case Worker and System Administrator permissions.
5. Test dashboard queues using realistic pending, under-review, correction-requested, approved, and denied requests.
6. Test SMS using a provider mock only.
7. Test website identity-proof access, correction requests, approval sequencing, and actionable error feedback.
8. Test applicant subject selection, receipt guidance, duplicate request handling, and simplified UI copy.
9. Rebuild the website and produce a new APK only when the mobile app changes have passed regression testing.
10. Do not release to production until each completed phase has been reviewed and approved.
11. Run Prompts 26 through 35 in order, keeping new rules in report-only mode until the relevant tests and client approvals are complete.

## Scope Boundaries

- This document arranges the work; it does not require implementing every future feature immediately.
- AI integration, SMS provider selection, MFA, and reports are future phases.
- Existing records should remain readable unless the client approves a data migration.
- No production deployment is included.


Prompt	Paste into
1	Flutter mobile app workspace
2	Flutter app first, then this AidLink_WEB workspace
3	Flutter app, then AidLink_WEB backend
4	Flutter app, AidLink_WEB backend, then website UI
5	Flutter app, AidLink_WEB backend, and website
6	Flutter app and AidLink_WEB backend
7	Flutter app, backend, and website
8	AidLink_WEB workspace
9	AidLink_WEB workspace
10	AidLink_WEB workspace
11	AidLink_WEB workspace
12	AidLink_WEB workspace
13	AidLink_WEB workspace, then Flutter app for applicant-facing notifications
14	Flutter app and AidLink_WEB backend
15	AidLink_WEB backend, with Flutter integration afterward
16	AidLink_WEB workspace
17	AidLink_WEB workspace, with Flutter integration for requestor viewing and QR delivery
18	AidLink_WEB workspace
19	AidLink_WEB workspace, then Flutter app for correction submission verification
20	AidLink_WEB workspace, then Flutter app if requestor status screens depend on the changed states
21	AidLink_WEB workspace and Flutter app
22	Flutter app, then AidLink_WEB backend and website review screens
23	Flutter app
24	Flutter app and AidLink_WEB backend
25	Flutter app and AidLink_WEB workspace
26	AidLink_WEB backend database foundation
27	AidLink_WEB backend and website
28	AidLink_WEB backend, then Flutter intake integration
29	AidLink_WEB backend and website administration
30	AidLink_WEB backend and website review workflow
31	AidLink_WEB backend and website review workflow
32	AidLink_WEB backend and website
33	AidLink_WEB backend and website
34	AidLink_WEB workspace
35	AidLink_WEB backend and website first, then Flutter integration for applicant status, corrections, cooldowns, and notifications