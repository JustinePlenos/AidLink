import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const execFileAsync = promisify(execFile);
const wordMimeTypes = new Set(['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const pdfMime = 'application/pdf';
const DAY_MS = 24 * 60 * 60 * 1000;
const accessTtlMs = 5 * 60 * 1000;

function defaultOfficePath() {
  if (process.platform !== 'win32') return 'soffice';
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'soffice';
}

export function classifyLetterFile(file) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const buffer = file.buffer;
  if (!buffer || buffer.length < 8 || buffer.length > 10 * 1024 * 1024) throw new Error('Choose a valid letter file no larger than 10 MB.');
  if (ext === '.pdf' && file.mimetype === pdfMime && buffer.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (ext === '.docx' && wordMimeTypes.has(file.mimetype) && buffer.subarray(0, 2).toString() === 'PK') return 'docx';
  if (ext === '.doc' && wordMimeTypes.has(file.mimetype) && buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return 'doc';
  throw new Error('Upload a valid PDF, DOC, or DOCX guarantee letter. File extension, format, and contents must match.');
}

export async function convertWordToPdf(source, type, options = {}) {
  const officePath = options.officePath || process.env.AIDLINK_LIBREOFFICE_PATH || defaultOfficePath();
  const run = options.run || execFileAsync;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlink-letter-'));
  try {
    const sourcePath = path.join(temporary, `source.${type}`);
    const profilePath = path.join(temporary, 'office-profile');
    await fs.writeFile(sourcePath, source, { flag: 'wx' });
    try {
      await run(officePath, [`-env:UserInstallation=file:///${profilePath.replaceAll('\\', '/')}`, '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', temporary, sourcePath], { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(error?.code === 'ENOENT' ? 'Word conversion is unavailable. Install LibreOffice on the server and configure AIDLINK_LIBREOFFICE_PATH.' : 'Word conversion failed. Check that the file is readable, then replace it.');
    }
    const pdfPath = path.join(temporary, 'source.pdf');
    try { return await fs.readFile(pdfPath); } catch { throw new Error('Word conversion did not produce a PDF. Replace the file and try again.'); }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareViewingPdf(pdfBuffer, requestNumber, version) {
  let pdf;
  try { pdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: false }); } catch { throw new Error('The guarantee letter PDF is corrupt, encrypted, or unreadable. Replace it before approval.'); }
  if (!pdf.getPageCount()) throw new Error('The guarantee letter PDF has no pages. Replace it before approval.');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const text = `AidLink view only - ${requestNumber} - version ${version}`;
    page.drawText(text, { x: Math.max(20, width / 2 - 175), y: height / 2, size: 16, font, color: rgb(0.55, 0.13, 0.13), opacity: 0.24, rotate: degrees(25) });
    page.drawText(`AidLink protected copy | ${requestNumber} | version ${version}`, { x: 24, y: 20, size: 9, font, color: rgb(0.45, 0.1, 0.1), opacity: 0.65 });
  }
  return Buffer.from(await pdf.save());
}

export function hashQrToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
export function issueLetterQr(secret, requestId, version, validityDays = 7, now = new Date()) {
  const days = Number(validityDays);
  if (!Number.isInteger(days) || days < 3 || days > 14) throw new Error('Guarantee Letter validity must be from 3 through 14 days.');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(now).getTime() + days * DAY_MS).toISOString();
  return { token, tokenHash: hashQrToken(token), expiresAt, requestId, version };
}

export function qrState(letter, token) {
  if (!letter) return 'unavailable';
  if (letter.status === 'expired') return 'expired';
  if (letter.status === 'revoked') return 'revoked';
  if (letter.status === 'replaced') return 'replaced';
  if (letter.status === 'conversion_failed') return 'unavailable';
  if (letter.status !== 'approved' || !letter.qrTokenHash) return 'pending';
  if (new Date(letter.qrExpiresAt).getTime() <= Date.now()) return 'expired';
  return hashQrToken(token) === letter.qrTokenHash ? 'approved' : 'replaced';
}

function signature(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
export function issuePdfAccess(secret, requestId, version, tokenHash) {
  const payload = Buffer.from(JSON.stringify({ requestId, version, tokenHash, exp: Date.now() + accessTtlMs })).toString('base64url');
  return `${payload}.${signature(secret, payload)}`;
}
export function verifyPdfAccess(secret, access, requestId, version, tokenHash) {
  try {
    const [payload, supplied] = String(access || '').split('.');
    const expected = signature(secret, payload);
    if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return value.exp > Date.now() && value.requestId === requestId && value.version === version && value.tokenHash === tokenHash;
  } catch { return false; }
}

export function letterStatusForApplicant(letter) {
  if (!letter) return 'unavailable';
  if (letter.status === 'expired') return 'expired';
  if (letter.status === 'revoked') return 'revoked';
  if (letter.status === 'replaced') return 'replaced';
  if (letter.status === 'conversion_failed') return 'unavailable';
  if (letter.status !== 'approved') return 'pending';
  return new Date(letter.qrExpiresAt).getTime() <= Date.now() ? 'expired' : 'approved';
}
