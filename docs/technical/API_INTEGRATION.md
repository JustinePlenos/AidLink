# Applicant app integration

## Base URL

- Android Studio emulator: `http://10.0.2.2:5000`
- Physical device on the same Wi-Fi: `http://<computer-lan-ip>:5000`

The backend must be running with `npm run backend`. Android development builds
using HTTP must enable cleartext traffic and include the Internet permission.

## Applicant flow

### 1. Register

`POST /api/applicant/auth/register` with JSON fields `fullName`, `email`,
`phone`, `address`, `dateOfBirth`, and `password`. The password must contain at
least eight characters. The response contains `user` and `token`. A new
account is created with `accountStatus: "basic"` and
`verificationStatus: "unverified"`.

### 2. Log in

`POST /api/applicant/auth/login` with `email` and `password`. Store the returned
token in Android encrypted storage. Send it on all following calls:

```text
Authorization: Bearer <token>
```

### Identity verification

Before full applicant features are enabled, upload one current government-issued
ID to `POST /api/applicant/identity-verification/document` as
`multipart/form-data` using the field `document`. The account becomes
`pending` while the file awaits review. Case Workers may view and flag it;
only a System Administrator can approve or reject it through
`PUT /api/applicant-verifications/:id/decision`. The applicant may read the
current result at `GET /api/applicant/identity-verification`.

### 3. Upload documents

`POST /api/applicant/documents` as `multipart/form-data`. Use `documents` as
the field name. Up to five PDF, JPG, or PNG files are accepted, with a 10 MB
limit per file. This endpoint is available only after identity approval. The
`documentType` must exactly match one configured checklist entry. The response is:

```json
{
  "documents": [{
    "id": "document-<stable-id>",
    "name": "medical-certificate.pdf",
    "url": "http://<server>:5000/uploads/<generated-name>.pdf",
    "documentType": "medical_certificate",
    "analysis": {
      "accepted": true,
      "issues": [],
      "warnings": [],
      "orientation": "not_applicable",
      "analyzerVersion": "aidlink-document-quality-v3",
      "analyzedAt": "2026-09-12T00:00:00.000Z",
      "authenticityVerified": false,
      "receipt": "server-signed-receipt"
    }
  }]
}
```

### 4. Submit an application

`POST /api/applicant/applications` with `assistanceType`, `incomeSource`,
`patientCircumstance`, optional `additionalDetails`, the exact configured
`documents` checklist, and `facilityEvidence` containing `facilityName`,
`facilityType`, `receiptDate`, `referenceNumber`, and
`receiptDocumentId`. Applicant profile fields are taken from the
authenticated account and cannot be impersonated in this call. `incomeSource`
and `patientCircumstance` must use one of the server-supported values. The
backend rejects missing checklist items, duplicate documents, future or stale
receipts, and receipt files that did not pass technical-quality analysis.

### 5. Load the applicant's history

- `GET /api/applicant/requests` returns only the signed-in applicant's requests.
- `GET /api/applicant/requests/:id` returns one owned request or HTTP 404.

Status values are `pending`, `under_review`, `correction_requested`, `approved`, and `denied`.

New approved requests include `guaranteeLetterTracking`, `qrCode`, and the
receipt-derived `facilityEvidence` in request endpoints. AidLink does not
maintain an accredited-facility assignment list. Historical records may still
contain legacy `assignedFacility` and `guaranteeLetter` metadata.
`qrCode.value` is a stable, securely generated verification token and
`qrCode.imageDataUrl` is its PNG data URL.

```json
{
  "status": "approved",
  "guaranteeLetterTracking": {
    "claimReference": "CLAIM-2026-001",
    "scheduledFor": "2026-09-20",
    "status": "scheduled"
  },
  "qrCode": {
    "value": "stored-verification-token",
    "imageDataUrl": "data:image/png;base64,..."
  }
}
```

To verify a scanned token, request `GET /api/qr/<token>`.

A Case Worker approves a request with JSON at `PUT /api/requests/:id/status`.
The body must include `status`, `remarks`, and `guaranteeLetterTracking`.
`facilityId` is rejected because facility assignment is no longer part of the
workflow. Accepted tracking statuses are `pending`, `scheduled`,
`ready_for_claiming`, `claimed`, and `cancelled`. After approval, update the
same three tracking fields with `PUT
/api/requests/:id/guarantee-letter-tracking`. Both endpoints enforce the Case
Worker permission and request assignment scope.

### Document pre-check

Before uploading, send one file as `multipart/form-data` to `POST /api/applicant/documents/analyze` using the field `document` and an optional `documentType`. The default deterministic analyzer checks file integrity, format, resolution, brightness, glare, sharpness, portrait/landscape orientation, and visible boundaries. Failed results include structured `issues` with an exact `message` and `fix`; the applicant must replace that file. Accepted results may include non-blocking `warnings`.

The upload endpoint repeats the analysis and returns a signed receipt. New applications must send the complete returned document object, including `analysis`; missing, failed, outdated, or tampered analysis is rejected. The stored result is technical-quality guidance only and never verifies authenticity.

The analyzer is accessed only through
`server/services/documentAnalyzer.js`. `setDocumentAnalyzer()` accepts a
deterministic, AI, or hybrid adapter with an id, version, capabilities, optional
confidence threshold, and async `analyze()` method. The normalization boundary
always forces `authenticityVerified` and `eligibilityDetermined` to false.
AI/hybrid results below the configured confidence threshold, or results that
suggest missing pages or likely unreadable text, remain uploadable but receive
`decision: human_review_required` and are attached to the application’s Case
Worker review summary. AI explanations and confidence are advisory only.

Analysis uses in-memory input and derived thumbnails only while the request is
being processed. Derived pixel buffers and request upload buffers are wiped
after analysis/storage. Stored documents use the authenticated `/uploads/:file`
route: applicants can access only their own staged or submitted files, while
staff access follows request and identity-review permissions. Responses use
private, no-store caching headers. `GET /api/system/document-analyzer` exposes
non-secret adapter capability and policy metadata to System Administrators.

### Requested document corrections

A Case Worker requests corrections with JSON at `PUT /api/requests/:id/status`:
set `status` to `correction_requested`, provide a clear `remarks` value, and
provide `correctionDocumentIds` as an array of stable
document IDs belonging to that request. The backend rejects missing, unknown,
or cross-request document IDs and sends an in-app notification to the linked
applicant.

The authenticated applicant can replace only those selected documents:

- `POST /api/applicant/requests/:id/corrections/documents/:documentId` with one
  `document` file and its `documentType`.
- `POST /api/applicant/requests/:id/corrections/submit` after every requested
  document has an accepted replacement.

Both endpoints resolve ownership from the bearer token, not an applicant ID or
email supplied by the client; a different applicant receives HTTP 404. Each
replacement is analyzed again. Failed quality checks return HTTP 422 with the
exact issue and corrective action. Successful submission moves the request to
`under_review`; previous documents, correction requirements, replacements,
remarks, timestamps, and acting users remain in document, correction, and
audit history.

### Notifications

`GET /api/applicant/notifications` returns only the signed-in applicant's
notifications. Staff notifications use `GET /api/notifications` and
`PUT /api/notifications/:id/read`. A production mobile build can poll the
applicant endpoint or connect the same stored events to Firebase Cloud Messaging.

### Approved-request SMS

When a stored request first changes to `approved`, the backend creates a
persistent SMS notification and attempts delivery through the active adapter.
The message contains the applicant/request identity, approval confirmation,
claiming date, time, and location, ID and authorized-representative
requirements, the configured help channel, and a password/OTP safety reminder.

The default adapter is deliberately `unconfigured`; it stores the message as
`pending_configuration` without pretending it was sent. A future provider
integration calls `setSmsProviderAdapter()` with an object containing a
provider-neutral `name` and async `send({ to, body, clientReference,
metadata })` function. The function returns `status` plus an optional
`providerMessageId`, or throws `SmsProviderError` with a retryable flag.

Delivery records retain status, attempt count, next retry time, provider
message ID, error, timestamps, and attempt history. Transient failures use
exponential retry scheduling, and the production server processes due retries
once per minute. Authorized staff can inspect `GET /api/sms-notifications`,
retry one message with `POST /api/sms-notifications/:id/retry`, or process
all due scoped messages with `POST /api/sms-notifications/retry-due`.
Provider delivery receipts post `delivered` or `failed` to
`POST /api/internal/sms-delivery-status` using
`x-aidlink-sms-status-secret`. Every queue, attempt, retry, and receipt
transition is written to the administrator activity ledger.

### Applicant multi-factor authentication

Applicant password login returns HTTP `202` with `mfaRequired`, a five-minute
`challengeToken`, permitted methods, and a masked phone number when MFA is
enabled. It does not return a bearer session until a second factor succeeds.

- `POST /api/applicant/auth/mfa/verify`: complete login with `totp`,
  `sms`, or `recovery_code`.
- `POST /api/applicant/auth/mfa/sms/request`: send an SMS recovery code
  through the provider-neutral SMS adapter.
- `GET /api/applicant/mfa`: return only safe MFA status metadata.
- `POST /api/applicant/mfa/totp/enroll/start`: confirm the current password
  and return an authenticator URI/QR setup response.
- `POST /api/applicant/mfa/totp/enroll/confirm`: verify TOTP, enable MFA, and
  return recovery codes once.
- `POST /api/applicant/mfa/step-up/start` and
  `POST /api/applicant/mfa/step-up/verify`: issue a single-use five-minute
  authorization for a sensitive account change.
- `POST /api/applicant/mfa/step-up/sms/request`: request SMS fallback for a
  step-up challenge.
- `POST /api/applicant/mfa/recovery-codes`: replace all recovery codes after
  step-up verification.
- `DELETE /api/applicant/mfa`: disable MFA after step-up verification.
- `PATCH /api/applicant/account/contact`: change email/phone after step-up.
- `POST /api/applicant/account/password`: change password after step-up.

Set `AIDLINK_MFA_ENCRYPTION_SECRET` to a dedicated production secret. TOTP
secrets are AES-256-GCM encrypted. Recovery codes and SMS OTPs are stored only
as keyed hashes. Authenticator codes cannot be replayed, recovery codes are
single-use, and account-security changes rotate the applicant session version.
SMS fallback is unavailable until an SMS provider adapter is configured.

### Reachable uploaded-file URLs

Set `AIDLINK_PUBLIC_BASE_URL`, for example `http://192.168.1.10:5000`, when the API is used by a physical phone. This prevents QR verification and applicant-document links from being generated with `localhost`.

## Legacy public integration

The applicant app creates a request by sending `POST /api/applications` to the same backend used by the CMO portal.

## Endpoint

```text
POST http://<CMO-SERVER-IP>:5000/api/applications
Content-Type: application/json
```

## Required request body

```json
{
  "fullName": "Juan Dela Cruz",
  "email": "juan@example.com",
  "phone": "09171234567",
  "address": "Barangay Example, Davao City",
  "dateOfBirth": "1990-01-15",
  "assistanceType": "Hospital Assistance",
  "incomeSource": "Salary or wages",
  "patientCircumstance": "Disease",
  "additionalDetails": "Needs help with the hospital bill.",
  "documents": [
    { "name": "Barangay Clearance", "url": "https://files.example.com/barangay-clearance.pdf" },
    { "name": "Hospital Bill", "url": "https://files.example.com/hospital-bill.pdf" },
    { "name": "Medical Certificate", "url": "https://files.example.com/medical-certificate.pdf" }
  ]
}
```

Do not send an amount. LINGAP records a CMO processing action for the bill or referral; it does not release cash to the applicant.

## Connection checklist

1. Keep the CMO backend running on one computer and put both devices on the same Wi-Fi network.
2. Run `ipconfig` on the CMO computer and give the applicant-app developer its IPv4 address, for example `192.168.1.10`.
3. In the applicant app, set the API base URL to `http://192.168.1.10:5000` — not `localhost`.
4. Submit the JSON body above to `/api/applications` and show the returned `requestId` to the applicant.
5. Ensure Windows Firewall allows incoming TCP traffic on port `5000` for the demo.
6. Submit one test application, then refresh the CMO portal. It will appear as **Pending**.

## Data-handling rules

- Use a stable applicant email address. The backend uses it to avoid duplicate applicant profiles and increments `totalApplications`.
- Upload the actual file to a file-storage service first, then send its accessible URL in `documents[].url`. This prototype does not accept raw file uploads yet.
- Keep the exact document names meaningful because CMO personnel use them during verification.
- Do not call CMO-only endpoints (`/api/requests`, `/api/users`, or status updates) from the applicant app.
- For production, replace `data.json` with a database and private document storage before allowing internet access.
