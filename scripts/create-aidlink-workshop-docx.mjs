import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  PageOrientation,
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

const outputPath = path.resolve('docs/outputs/AidLink_Week3_Day2_Workshop_Output.docx');
const navy = '17324D';
const teal = '167D83';
const gray = '52606D';

const text = (value, options = {}) => new TextRun({ font: 'Aptos', size: 22, color: '243B53', ...options, text: value });
const paragraph = (value, options = {}) => new Paragraph({ spacing: { after: 130, line: 276 }, ...options, children: [text(value)] });
const bullet = (value) => new Paragraph({ style: 'ListBullet', spacing: { after: 80 }, children: [text(value)] });
const heading = (value, level = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, spacing: { before: 280, after: 140 }, children: [new TextRun({ font: 'Aptos Display', size: level === HeadingLevel.HEADING_1 ? 30 : 25, bold: true, color: navy, text: value })] });

function cell(value, header = false) {
  return new TableCell({
    shading: header ? { fill: navy, type: ShadingType.CLEAR } : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({ spacing: { after: 0 }, children: [text(value, { bold: header, color: header ? 'FFFFFF' : '243B53' })] })],
  });
}

function twoColumnTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, top: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' } },
    rows: [new TableRow({ children: [cell('Area', true), cell('Workshop Output', true)] }), ...rows.map(([left, right]) => new TableRow({ children: [cell(left), cell(right)] }))],
  });
}

const doc = new Document({
  creator: 'AidLink project team',
  title: 'AidLink Week 3 Day 2 Workshop Output',
  subject: 'System analysis and requirements workshop output',
  sections: [{
    properties: { page: { size: { orientation: PageOrientation.PORTRAIT, width: 12240, height: 15840 }, margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 700, after: 180 }, children: [new TextRun({ font: 'Aptos Display', size: 52, bold: true, color: navy, text: 'AidLink' })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ font: 'Aptos Display', size: 30, bold: true, color: teal, text: 'Week 3 Day 2 Workshop Output' })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 650 }, children: [new TextRun({ font: 'Aptos', size: 24, italic: true, color: gray, text: 'Requirements, workflow, and system design documentation' })] }),
      new Table({
        width: { size: 82, type: WidthType.PERCENTAGE },
        alignment: AlignmentType.CENTER,
        borders: { insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, top: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D9E2EC' } },
        rows: [
          new TableRow({ children: [cell('Student Name', true), cell('[Write your name here]')] }),
          new TableRow({ children: [cell('Course / Section', true), cell('[Write your course and section here]')] }),
          new TableRow({ children: [cell('Instructor', true), cell('[Write your teacher\'s name here]')] }),
          new TableRow({ children: [cell('Date Submitted', true), cell('September 23, 2026')] }),
        ],
      }),
      new Paragraph({ spacing: { before: 720 }, children: [text('Project focus: A secure web-based operations portal for managing social assistance applications, applicant documents, case-worker review, identity verification, reporting, and audit activity.')] }),
      heading('1. Project Overview'),
      paragraph('AidLink is a digital assistance-request management system designed to help an organization receive, review, approve, and track applications for support. It connects applicant intake with a staff operations portal so that requests can be processed consistently and securely.'),
      paragraph('The website centralizes work queues, request details, document review, staff permissions, applicant verification, reporting, notifications, and system activity. The backend enforces the same rules as the interface so that protected operations do not depend only on hidden buttons or frontend visibility.'),
      heading('2. Problem Statement'),
      paragraph('Manual or fragmented assistance processing makes it difficult to track applications, verify supporting documents, assign work, protect personal information, and explain how decisions were made. Staff may also lose time searching for records or checking requirements that vary by assistance type.'),
      paragraph('AidLink addresses this problem by providing a single workflow for intake, review, correction requests, approval or denial, and audit reporting. The system is designed for accountable processing while preserving historical records and limiting access according to staff roles.'),
      heading('3. Objectives'),
      ...[
        'Provide a clear dashboard for new, pending, under-review, correction-requested, approved, denied, and stale applications.',
        'Allow Case Workers to review assigned or permitted requests and process supporting documents.',
        'Allow System Administrators to manage staff accounts, roles, audit logs, system settings, and reports.',
        'Protect applicant identity information, uploaded documents, MFA data, and private guarantee-letter files.',
        'Use consistent validation and assistance-type rules across the applicant workflow, API, and staff portal.',
        'Maintain an audit trail for security events, workflow changes, document activity, and administrative actions.',
      ].map(bullet),
      heading('4. Stakeholders and Roles'),
      twoColumnTable([
        ['Applicant', 'Submits an assistance request, uploads required documents, verifies identity, receives corrections, and tracks request progress.'],
        ['Case Worker', 'Reviews permitted requests, checks documents, requests corrections, validates facility evidence, and approves or denies requests.'],
        ['System Administrator', 'Manages staff accounts, roles, assistance types, required documents, system settings, audit activity, and reports.'],
        ['Organization / Client', 'Defines assistance policies, required evidence, workflow settings, and reporting needs.'],
      ]),
      heading('5. Functional Requirements'),
      twoColumnTable([
        ['FR-01: Authentication', 'The system shall authenticate staff and applicants separately and shall not allow public staff registration.'],
        ['FR-02: Role permissions', 'The backend shall enforce Case Worker and System Administrator permissions on protected endpoints.'],
        ['FR-03: Application queues', 'The dashboard and request table shall use consistent filters and queue statuses.'],
        ['FR-04: Document intake', 'The system shall accept required applicant documents and analyze technical quality before final submission.'],
        ['FR-05: Corrections', 'A Case Worker shall be able to request specific document corrections, and an applicant shall be able to replace requested files.'],
        ['FR-06: Decision workflow', 'A permitted Case Worker shall be able to approve or deny a request after required review steps are complete.'],
        ['FR-07: Applicant verification', 'A System Administrator shall be able to review and make the final applicant identity-verification decision.'],
        ['FR-08: Reporting', 'A System Administrator shall be able to view summaries and generate reports from authorized system data.'],
        ['FR-09: Audit activity', 'The system shall record actor, action, affected record, timestamp, and relevant structured details.'],
        ['FR-10: Notifications', 'The system shall create and track approval SMS delivery records through a provider-neutral adapter.'],
      ]),
      heading('6. Non-Functional Requirements'),
      twoColumnTable([
        ['Security', 'Use authenticated access, role checks, private file storage, MFA protection, signed access grants, and secure password handling.'],
        ['Privacy', 'Restrict applicant documents and identity data to the applicant owner or authorized staff. Avoid storing secrets or recovery codes in readable form.'],
        ['Reliability', 'Preserve existing records, maintain workflow history, and use durable storage for uploaded files and protected letters.'],
        ['Usability', 'Present clear queues, status labels, correction remarks, validation messages, and administrator help text.'],
        ['Maintainability', 'Keep business rules provider-neutral and share canonical assistance-type and intake definitions across system layers.'],
        ['Auditability', 'Make security-sensitive and administrative actions traceable without exposing passwords, tokens, or MFA secrets.'],
      ]),
      heading('7. Main Workflow'),
      ...[
        'An applicant registers or signs in and submits an assistance request.',
        'The applicant selects an assistance type and uploads the required supporting documents.',
        'The system validates file format and analyzes document quality for readability, resolution, blur, brightness, glare, cropping, and orientation.',
        'The request enters the staff work queue for a permitted Case Worker.',
        'The Case Worker reviews the request and may request corrections, approve it, or deny it with an appropriate record of the action.',
        'For approved requests, the system records claim information and creates an SMS delivery record through the configured provider adapter.',
        'The System Administrator can review audit activity, manage configuration, and generate authorized reports.',
      ].map((value) => bullet(value)),
      heading('8. Security and Privacy Controls'),
      ...[
        'Staff registration is disabled; staff accounts are provisioned by an authorized System Administrator.',
        'Case Worker and System Administrator permissions are enforced by the backend for every protected operation.',
        'Applicant MFA uses a TOTP authenticator as the primary factor, with recovery options handled through protected hashes and encryption.',
        'Uploaded documents use authenticated access and no-store response headers; private guarantee-letter files are stored outside public uploads.',
        'Sensitive account changes require a short-lived step-up token and invalidate other applicant sessions after successful changes.',
        'Audit records omit passwords, MFA secrets, recovery codes, and other credentials.',
      ].map(bullet),
      heading('9. Testing and Validation Plan'),
      twoColumnTable([
        ['Unit and integration tests', 'Test assistance-type validation, permissions, applicant verification, MFA, document analysis, reporting, workflow order, and notification behavior.'],
        ['Security checks', 'Verify that unauthorized staff cannot access restricted endpoints, applicants cannot access another applicant\'s documents, and deactivated staff tokens are rejected.'],
        ['Workflow checks', 'Verify correction requests, document replacement, approval prerequisites, denial, queue counts, and stale-request handling.'],
        ['Usability checks', 'Confirm that labels, error messages, queue filters, administrator explanations, and request details are understandable to intended users.'],
      ]),
      heading('10. Current Implementation Summary'),
      paragraph('The AidLink website and Express backend include staff authentication, role separation, application queues, document-quality analysis, applicant verification, MFA support, audit activity, reporting, SMS delivery records, and protected guarantee-letter handling. Existing historical records remain readable where business requirements call for backward compatibility.'),
      paragraph('The project should continue to be validated against the client-approved assistance-type list, exact intake questions, required-document rules, deployment secrets, private storage configuration, and production retention policy before release.'),
      heading('11. Reflection'),
      paragraph('This workshop clarified that the most important part of AidLink is not only the interface but the relationship between requirements, permissions, workflow states, stored records, and audit evidence. A useful system must guide users through the correct process while also preventing unauthorized actions through backend controls.'),
      paragraph('The next development priority is to keep the requirements traceable to implementation and tests. This helps the team detect gaps early, preserve historical data safely, and demonstrate to stakeholders that the system supports both operational efficiency and responsible handling of applicant information.'),
      new Paragraph({ spacing: { before: 500 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: teal } }, children: [text('Prepared for submission. Replace the bracketed student, course, and instructor fields before turning in.', { italic: true, color: gray })] }),
    ],
  }],
  styles: {
    default: { document: { run: { font: 'Aptos', size: 22, color: '243B53' }, paragraph: { spacing: { line: 276 } } } },
    paragraphStyles: [{ id: 'ListBullet', name: 'List Bullet', basedOn: 'Normal', next: 'Normal', run: { font: 'Aptos', size: 22 }, paragraph: { indent: { left: 360, hanging: 180 }, spacing: { after: 80 } } }],
  },
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outputPath, buffer);
console.log(`Created ${outputPath}`);