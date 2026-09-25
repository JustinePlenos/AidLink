import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import fs from 'node:fs';
import path from 'node:path';

const outputPath = path.resolve('docs/outputs/AidLink_Week3_Day2_Workshop_Output_Complete_v2.docx');
const colors = { navy: '17324D', teal: '167D83', ink: '243B53', muted: '52606D', line: 'CBD5E1', pale: 'EAF3F6', white: 'FFFFFF' };

const run = (value, options = {}) => new TextRun({ font: 'Aptos', size: 19, color: colors.ink, ...options, text: value });
const p = (value, options = {}) => new Paragraph({ spacing: { after: 90, line: 260 }, ...options, children: [run(value)] });
const h = (value, level = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, spacing: { before: 250, after: 110 }, children: [new TextRun({ font: 'Aptos Display', size: level === HeadingLevel.HEADING_1 ? 27 : 23, bold: true, color: colors.navy, text: value })] });

function makeCell(value, header = false) {
  const values = Array.isArray(value) ? value : [value];
  const children = values.map((item) => new Paragraph({
    spacing: { after: Array.isArray(value) ? 45 : 0, line: 240 },
    children: [run(item, { color: header ? colors.white : colors.ink, bold: header })],
  }));
  return new TableCell({
    shading: header ? { fill: colors.navy, type: ShadingType.CLEAR } : undefined,
    margins: { top: 90, bottom: 90, left: 100, right: 100 },
    children,
  });
}

function table(headers, rows, widths = undefined) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    borders: Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((side) => [side, { style: BorderStyle.SINGLE, size: 4, color: colors.line }])),
    rows: [
      new TableRow({ children: headers.map((item) => makeCell(item, true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((item) => makeCell(item)) })),
    ],
  });
}

const infoRows = [
  ['Project title', 'AidLink: A Centralized Digital Assistance Management System for Davao City'],
  ['Program / office context', 'Lingap Para sa Mahirap Program, Lingap Bunawan Satellite Office'],
  ['Workshop output', 'Week 3 Day 2: requirements, scope, stakeholders, validation, and readiness tables'],
  ['Proponents', 'Micko Jay Niño P. Llanos; Allyson M. Manulat; Justine M. Pleños'],
  ['School / subject', 'Assumption College of Davao, Information Technology Education Program, Capstone 2'],
  ['Instructor / date', 'Ms. Roselyn M. Biala, MIT / September 2026'],
];

const problemRows = [
  ['P1', 'In-person submission and follow-up bottlenecks', 'Applicants may need repeated visits or direct inquiries for submission, clarification, verification, and status follow-up.', 'Applicant portal, online submission, status monitoring, and stored notifications.'],
  ['P2', 'Manual document verification delays', 'Personnel must individually check requirements and communicate when information is incomplete.', 'Structured document upload, validation, quality pre-checking, and administrative review.'],
  ['P3', 'Fragmented assistance records', 'Related applicant, application, document, and transaction information can be difficult to retrieve across separate records.', 'Centralized applicant, application, document, and transaction records within the defined scope.'],
  ['P4', 'Limited application-status visibility', 'Applicants may contact the office to learn whether additional action or requirements are needed.', 'Applicant request history, status updates, and notifications.'],
  ['P5', 'Risk of duplicate assistance requests', 'Personnel may need additional effort to locate and compare previous assistance transactions.', 'Centralized histories and tools that support review of potentially repeated requests.'],
];

const objectiveRows = [
  ['O1', 'General objective', 'Develop a centralized system that supports organized submission, processing, monitoring, and management of assistance applications and related records.'],
  ['O2', 'Integrated portals', 'Allow applicants to register, submit applications and documents, and monitor status while authorized personnel securely review and update records.'],
  ['O3', 'Document management', 'Organize, validate, and retrieve applicant submissions and supporting records.'],
  ['O4', 'Centralized records', 'Support review of applicant and assistance information and identification of potentially repeated requests within the system.'],
  ['O5', 'Status monitoring', 'Allow applicants to view relevant status updates without relying solely on direct office inquiries.'],
  ['O6', 'Protection and authorization', 'Apply access control, validation, and privacy mechanisms according to user roles.'],
];

const scopeRows = [
  ['Applicant assistance portal', 'Registration, assistance requests, supporting-document upload, and application-status viewing.'],
  ['Administrative management', 'Application review, requirement inspection, status updates, remarks, and record management by authorized personnel.'],
  ['Application and record management', 'Organization of applicant information, applications, documents, and related transaction records.'],
  ['Guarantee Letter and QR', 'Access to generated Guarantee Letter information through a QR reference; external partner verification remains subject to deployment and testing.'],
  ['Boundary', 'Davao City Lingap scope only; no blockchain, direct financial disbursement, offline processing, or replacement of authorized personnel.'],
  ['Prototype constraint', 'React 18/Vite frontend, Node.js/Express backend, JSON-file persistence, and local document storage; PostgreSQL and private production storage are future requirements.'],
];

const stakeholderRows = [
  ['Applicant / resident', 'Register, submit, upload, view request history, monitor status, and receive notifications.', 'Supplies accurate information; cannot perform administrative decisions.'],
  ['Authorized administrative personnel', 'Review requests and documents, record remarks, update status, and manage records.', 'Retains responsibility for verification, approval/rejection, and proper information handling.'],
  ['Hospital / pharmacy verifier', 'May use QR lookup when formally deployed and reachable.', 'Partner onboarding, authorization policy, and operational integration require separate validation.'],
  ['System maintainer', 'Configures paths, secrets, backups, public URLs, and runtime services.', 'Must replace development secrets and prototype storage before public deployment.'],
];

const functionalRows = [
  ['FR-01', 'Register and authenticate applicant', 'High', 'Registration/login API and bearer-token generation', 'Valid registration/login succeeds; invalid credentials are rejected.'],
  ['FR-02', 'Submit assistance application', 'High', 'Authenticated application-submission endpoint', 'Submission uses the authenticated profile and receives a unique request ID.'],
  ['FR-03', 'Upload and validate documents', 'High', 'Multipart upload and document-analysis endpoints', 'Permitted formats, quantities, and file sizes are enforced.'],
  ['FR-04', 'View owned history and status', 'High', 'Applicant history and detail endpoints', 'Applicant retrieves only records associated with the authenticated account.'],
  ['FR-05', 'Review and record decisions', 'High', 'Administrative request-management/status routes', 'Authorized personnel update status with remarks and processing information.'],
  ['FR-06', 'Maintain audit evidence', 'High', 'Audit-log collection', 'Status changes retain actor, time, previous status, new status, and remarks.'],
  ['FR-07', 'Generate approval document and QR', 'High', 'Guarantee Letter and QR structures', 'Approved application retains document information and stable QR token.'],
  ['FR-08', 'Provide in-system notifications', 'Medium', 'Notification records and read endpoint', 'Intended applicant retrieves and marks notifications as read.'],
  ['FR-09', 'Manage facilities and requirements', 'Medium', 'Facility and required-document structures', 'Authorized configuration changes persist and affect applicable workflow.'],
  ['FR-10', 'External SMS/email', 'Low', 'No verified external gateway in prototype', 'Deferred until an approved gateway is implemented and tested.'],
];

const qualityRows = [
  ['Security', 'Protected endpoints require authentication and authorized administrative roles.', 'Negative route and authorization-bypass testing'],
  ['Privacy', 'Collect workflow-relevant information and restrict access by ownership or authorization.', 'Data-flow review and access-control testing'],
  ['Performance', 'Normal requests meet an agreed response-time threshold under documented conditions.', 'Timed testing with documented environment'],
  ['Reliability', 'Validation and file failures return controlled errors without corrupting records.', 'Fault injection, restart, and recovery testing'],
  ['Usability', 'Applicants and personnel complete major tasks using understandable controls and feedback.', 'Task-based usability testing / UAT'],
  ['Maintainability', 'Paths, secrets, URLs, and environment settings are configurable without source edits.', 'Configuration and clean-installation review'],
  ['Compatibility', 'Major workflows work on identified browsers and screen sizes.', 'Browser and responsive-interface testing'],
  ['Accessibility', 'Controls, labels, messages, and navigation provide basic accessibility support.', 'Keyboard, contrast, labels, and layout review'],
];

const traceRows = [
  ['FR-01', 'Authentication and access', 'Registration, login, password processing, token generation', 'Valid/duplicate registration, valid/invalid login, expired-token tests'],
  ['FR-02', 'Application management', 'Authenticated submission route', 'Complete, missing-field, invalid-type, unauthorized-submission tests'],
  ['FR-03', 'Document management', 'Multipart upload and analysis routes', 'Format, size, count, and upload-failure tests'],
  ['FR-04', 'Applicant request', 'Owned list and detail routes', 'Owner-access and cross-account denial tests'],
  ['FR-05', 'Administrative review', 'Review and status operations', 'Authorized/unauthorized review, valid/invalid transition tests'],
  ['FR-06', 'Audit component', 'Audit records during processing', 'Actor, timestamp, old/new status, and remarks verification'],
  ['FR-07', 'Output and QR', 'Guarantee Letter information and QR token', 'Output, stable-token, valid-token, invalid-token tests'],
  ['FR-08', 'Notification component', 'Notification collection and read-state endpoint', 'Intended-user retrieval and unauthorized-access tests'],
  ['FR-09', 'Reference data', 'Facility and requirement structures', 'Create, update, deactivate, retrieve, and persistence tests'],
  ['FR-10', 'External notification adapter', 'No verified gateway implementation', 'Deferred until gateway implementation and testing'],
];

const uatRows = [
  ['Client background is insufficient', 'Add medical condition, diagnosis, employment, income, socioeconomic, and family-support information.', 'Partial'],
  ['Requester and patient may differ', 'Provide separate requester and client/patient fields.', 'Implemented'],
  ['Multiple requests under one account', 'Retain history while separately identifying the client/patient.', 'Implemented'],
  ['Guarantee Letter is not the official copy', 'Make online copy view-only and state that the signed/sealed original must be claimed.', 'Implemented'],
  ['QR may validate patient, provider, and letter', 'Link QR to official record and control number.', 'Partial'],
  ['Provider details must be accurate', 'Validate provider name and address before approval and document generation.', 'Partial'],
  ['Medicine assistance needs prescriptions/quotations/computation', 'Remove it from the general online workflow or design a separate validated workflow.', 'Not implemented for new application'],
  ['Applicant should select satellite office', 'Add branch selection and route/filter requests by responsible office.', 'Not implemented'],
];

const readinessRows = [
  ['Persistence', 'Migrate to PostgreSQL or approved transactional database with constraints and migrations.', 'Not ready'],
  ['Document storage', 'Use private access-controlled storage with retention, deletion, and malware scanning.', 'Partial'],
  ['Secrets and transport', 'Replace development secrets, enforce HTTPS, and secure configuration values.', 'Partial'],
  ['Identity and access', 'Complete credential migration, role matrix, session controls, and authorization testing.', 'Mostly implemented'],
  ['Backup and recovery', 'Automate backups, define retention/ownership, and conduct restoration testing.', 'Not implemented'],
  ['Monitoring and incident response', 'Add structured logs, health monitoring, alerts, and an incident procedure.', 'Partial'],
  ['Users and operations', 'Provide guidance, training, administration, maintenance ownership, and support contacts.', 'Partial'],
  ['Governance and acceptance', 'Obtain authorized acceptance, privacy approval, and partner agreements.', 'Not implemented'],
];

const children = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 450, after: 90 }, children: [new TextRun({ font: 'Aptos Display', size: 46, bold: true, color: colors.navy, text: 'AidLink' })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 90 }, children: [new TextRun({ font: 'Aptos Display', size: 28, bold: true, color: colors.teal, text: 'Week 3 Day 2 Workshop Output' })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 380 }, children: [new TextRun({ font: 'Aptos', size: 21, italic: true, color: colors.muted, text: 'Table-based requirements and system analysis worksheet' })] }),
  table(['Submission field', 'Manuscript-based entry'], infoRows),
  p('Source used: AidLink manuscript provided by the proponents. This output distinguishes implemented prototype capabilities from requirements that still need testing, validation, or production preparation.', { spacing: { before: 180, after: 120 } }),

  h('PART 1: ARCHITECTURE MAPPING'),
  p('Describe each part of the AidLink architecture. The current mapping reflects the evaluated prototype and identifies production deployment considerations where applicable.'),
  table(['Component', 'Description of AidLink\'s version of this component'], [
    ['Client', 'React 18 and Vite web interface with separate applicant and administrative workflows. Applicants register, submit requests, upload documents, view status, and receive notifications. Authorized personnel review requests, documents, statuses, remarks, facilities, requirements, and activity.'],
    ['Server / Hosting', 'Node.js with Express provides the API and serves the prototype workflow. The current project is suitable for controlled development and demonstration. Production should separate frontend, API, database, and private document storage behind HTTPS.'],
    ['Application', 'Express routes and application services handle authentication, role-based authorization, applicant ownership, application submission, document validation and analysis, status processing, audit logging, notifications, Guarantee Letter references, and QR-token lookup.'],
    ['Database', 'The prototype uses structured JSON-file persistence and local application storage for documents. PostgreSQL or another approved transactional database is recommended for production, with private managed document storage and defined retention.'],
    ['External Services (if any)', 'QR generation/token lookup and optional document-quality analysis are present in the prototype. External SMS/email delivery and hospital/pharmacy QR partner integration are not verified. LibreOffice may be required for DOC/DOCX Guarantee Letter conversion.'],
  ]),

  h('PART 2: DEPLOYMENT REQUIREMENTS'),
  table(['Requirement', 'Details'], [
    ['Runtime/Language Version', 'Frontend: React 18 with Vite. Backend: Node.js with Express. Use the project dependency lock/configuration files and a supported Node.js runtime during deployment.'],
    ['Database Type', 'Prototype: structured JSON data file. Production requirement: PostgreSQL or another approved transactional database with migrations, constraints, backups, and least-privilege credentials.'],
    ['Storage Needs', 'Durable private storage for applicant uploads and protected Guarantee Letter originals/converted files. Production storage must support access control, retention, deletion, backup, and malware scanning.'],
    ['Environment Variables Needed', 'VITE_API_BASE_URL; PORT; AIDLINK_PUBLIC_BASE_URL; AIDLINK_DATA_PATH; AIDLINK_UPLOADS_PATH; AIDLINK_LETTERS_PATH; AIDLINK_TOKEN_SECRET; AIDLINK_MFA_ENCRYPTION_SECRET; AIDLINK_MFA_AUDIT_SECRET; AIDLINK_SMS_STATUS_SECRET; AIDLINK_LIBREOFFICE_PATH.'],
    ['Third-Party Keys Needed', 'No verified external provider key is required for the current prototype. A production SMS provider credential and trusted callback secret will be needed if SMS delivery is enabled. Any external identity or partner-verification integration requires approved credentials and agreements.'],
  ]),

  h('PART 3: HOSTING / DATABASE CONFIGURATION CHECK'),
  table(['Item', 'Status', 'Notes'], [
    ['Hosting account/provider selected', 'Pending', 'The prototype runs in a controlled local/development environment. A production hosting provider and deployment owner have not been evidenced in the manuscript.'],
    ['Production database created', 'Not ready', 'The prototype uses JSON-file persistence. Migrate to PostgreSQL or another approved transactional database before operational deployment.'],
    ['Database structure/data ready to import', 'Partial', 'Existing JSON records and structures are available for migration planning, but field reconciliation, migration scripts, constraints, and validation are still required.'],
    ['Domain/URL identified', 'Pending', 'A public production URL is not established. Configure AIDLINK_PUBLIC_BASE_URL when an approved domain is assigned.'],
    ['SSL/HTTPS availability confirmed', 'Not confirmed', 'HTTPS is required before internet-facing deployment; it is not established by the current prototype configuration.'],
  ]),

  h('PART 4: DRAFT DEPLOYMENT CHECKLIST'),
  p('Ordered steps the AidLink group will follow for deployment on Day 3.'),
  table(['Step #', 'Action'], [
    ['1', 'Confirm the approved deployment target, hosting provider, domain/URL, deployment owner, and responsible administrator.'],
    ['2', 'Prepare the production runtime and configuration: supported Node.js environment, frontend build settings, API URL, HTTPS, and secure environment variables.'],
    ['3', 'Create the production database and private document storage, then apply the approved schema, constraints, access permissions, retention rules, and migration plan.'],
    ['4', 'Migrate only approved non-sensitive or authorized data, validate record counts and relationships, and preserve a recoverable backup of the prototype data.'],
    ['5', 'Deploy the frontend and Express API, configure private uploads and Guarantee Letter storage, and verify authentication, role permissions, applicant ownership, document access, and QR behavior.'],
    ['6', 'Run smoke, security, backup/recovery, and workflow checks; record defects and results; obtain authorized acceptance before opening the system to intended users.'],
  ]),

  h('A. Project Context'),
  table(['Context question', 'Answer from the manuscript'], [
    ['What is AidLink?', 'A centralized web-based assistance management system for the Lingap Para sa Mahirap Program in Davao City.'],
    ['What operational concerns does it address?', 'Repeated applicant visits, manual document checking, fragmented assistance records, limited status visibility, and difficulty retrieving previous transactions.'],
    ['What does it replace?', 'It does not replace authorized personnel, official eligibility judgment, physical assistance delivery, or financial disbursement.'],
    ['What is the current prototype stack?', 'React 18 and Vite; Node.js and Express; structured JSON-file persistence; local document storage.'],
  ]),

  h('B. Problem Analysis'),
  table(['ID', 'Priority problem', 'Observed impact', 'AidLink response'], problemRows),

  h('C. Objectives and Scope'),
  table(['ID', 'Objective type', 'Objective statement'], objectiveRows),
  table(['Scope area', 'Included capability or boundary'], scopeRows),

  h('D. Stakeholder Table'),
  table(['Stakeholder', 'Implemented interaction', 'Responsibility / boundary'], stakeholderRows),

  h('E. Functional Requirements Table'),
  table(['ID', 'Functional requirement', 'Priority', 'Implementation evidence', 'Acceptance condition'], functionalRows),

  h('F. Quality and Non-Functional Requirements'),
  table(['Quality area', 'Requirement', 'Required verification'], qualityRows),

  h('G. Requirements Traceability Table'),
  table(['Requirement', 'Design component', 'Implementation evidence', 'Required test evidence'], traceRows),

  h('H. Implementation and Evaluation Status'),
  table(['Area', 'Current manuscript finding', 'Status / qualification'], [
    ['Applicant account', 'Registration, login, authenticated sessions, and account-linked history.', 'Implemented; complete negative, session, and credential testing.'],
    ['Application processing', 'Assistance selection, reason entry, document references, submission, review, status, and remarks.', 'Implemented; retain and verify every supported assistance type.'],
    ['Document handling', 'PDF/JPG/JPEG/PNG upload, maximum five files, maximum 10 MB per file.', 'Implemented for prototype; add malware scanning and private storage before production.'],
    ['Administrative operations', 'Dashboard, queue, applicant lookup, request details, decision history, and configuration.', 'Implemented; complete role and authorization-bypass testing.'],
    ['Audit and notifications', 'Recorded status-change events and stored in-system notifications.', 'Implemented; do not claim external SMS/email delivery.'],
    ['Guarantee Letter and QR', 'Approval artifact reference, stable QR token, and token lookup.', 'Partially implemented; pilot with an authorized verifier.'],
    ['Production database/storage', 'PostgreSQL and private managed storage are recommended, not current prototype components.', 'Delayed; complete before operational deployment.'],
  ]),

  h('I. UAT Findings and Required Revisions'),
  p('User Acceptance Testing involved one authorized representative of the Lingap Bunawan Satellite Office. These findings are actionable client feedback, not a statistically representative evaluation of all users.'),
  table(['UAT finding', 'Recommended system action', 'Status'], uatRows),

  h('J. Production-Readiness Checklist'),
  table(['Readiness area', 'Required action before production', 'Current assessment'], readinessRows),

  h('K. Workshop Synthesis'),
  table(['Decision / question', 'Workshop answer'], [
    ['Core value', 'AidLink organizes applicant submission, document handling, administrative review, status monitoring, and record retrieval in one workflow.'],
    ['Human decision point', 'Authorized Lingap personnel remain responsible for verification, approval/rejection, and official document handling.'],
    ['Most important revision from UAT', 'Expand intake information, distinguish requester from patient, validate providers, support satellite-office selection, and separate medicine assistance from the general online workflow.'],
    ['Evidence still needed', 'Broader usability testing, security and ownership tests, performance measurements, backup/recovery tests, partner QR pilot, and signed traceability/test records.'],
    ['Release position', 'Functional and evaluated prototype for controlled demonstration; not yet ready for unrestricted public or citywide deployment.'],
  ]),
  new Paragraph({ spacing: { before: 350 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: colors.teal } }, children: [run('Before submission: replace or confirm the submission fields on the first table, then review the status labels against the latest approved manuscript.', { italic: true, color: colors.muted })] }),
];

const document = new Document({
  creator: 'AidLink proponents',
  title: 'AidLink Week 3 Day 2 Workshop Output - Table Format',
  subject: 'Table-based requirements and system analysis workshop output',
  sections: [{ properties: { page: { size: { width: 15840, height: 12240 }, margin: { top: 650, right: 650, bottom: 650, left: 650 } } }, children }],
  styles: { default: { document: { run: { font: 'Aptos', size: 19, color: colors.ink }, paragraph: { spacing: { line: 260 } } } } },
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, await Packer.toBuffer(document));
console.log(`Created ${outputPath}`);