/**
 * buildAdminData.js
 * Scans MEGA Cloud for all registrations and builds admin-data.json
 * for the GitHub Pages admin dashboard.
 *
 * This version reads directly from MEGA (no API dependency).
 * Environment: MEGA_EMAIL, MEGA_PASSWORD set in docker-compose.yml
 */

import { Storage } from 'megajs';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';

const BATCH_FOLDERS = [
  '2020 Batch', '2021 Batch', '2022 Batch',
  '2023 Batch', '2024 Batch', '2025 Batch',
];

function normalizeReviewStatus(status) {
  if (!status) return 'Pending';
  const s = String(status).toLowerCase().trim();
  if (s === 'approved' || s === 'accept') return 'Approved';
  if (s === 'rejected' || s === 'reject') return 'Rejected';
  return 'Pending';
}

function normalizeBatch(batch) {
  if (!batch) return null;
  const text = String(batch).trim();
  const match = text.match(/202[0-5]/);
  if (match) return `${match[0]} Batch`;
  return BATCH_FOLDERS.find(b => b.toLowerCase() === text.toLowerCase()) || text;
}

function normalizeIdentityName(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function mimeFromName(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.pdf': 'application/pdf', '.webp': 'image/webp',
  };
  return types[ext] || 'application/octet-stream';
}

function profileExtension(originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext;
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

// MEGA instance cache
let mega = null;

async function getMegaInstance() {
  if (mega) return mega;
  const email = (process.env.MEGA_EMAIL || '').trim();
  const password = (process.env.MEGA_PASSWORD || '').trim();
  if (!email || !password) return null;

  mega = await new Storage({ email, password }).ready();
  return mega;
}

async function ensureMegaFolder(parent, name) {
  if (!parent) return null;
  const existing = (parent.children || []).find(c => c.name === name);
  if (existing && existing.directory) return existing;
  return await parent.mkdir(name);
}

async function readMegaJsonFile(folder, filename) {
  const file = (folder.children || []).find(c => c.name === filename);
  if (!file || file.directory) return null;
  try {
    const stream = file.download();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function listMegaRegistrations(root, defaultStatus) {
  const output = [];
  if (!root) return output;

  for (const batchFolder of (root.children || [])) {
    if (!batchFolder.directory) continue;
    for (const artistFolder of (batchFolder.children || [])) {
      if (!artistFolder.directory) continue;

      // Read artist-info.json for metadata
      let artistInfo = null;
      try {
        artistInfo = await readMegaJsonFile(artistFolder, 'artist-info.json');
      } catch {}

      for (const regFolder of (artistFolder.children || [])) {
        if (!regFolder.directory) continue;
        let registration = null;
        try {
          registration = await readMegaJsonFile(regFolder, 'artwork-info.json');
        } catch {}

        if (!registration) continue;

        const batchName = normalizeBatch(batchFolder.name);
        const fullReg = {
          id: registration.id || regFolder.name,
          artistId: registration.artistId || artistInfo?.artistId || '',
          status: normalizeReviewStatus(registration.status || defaultStatus),
          createdAt: registration.createdAt,
          updatedAt: registration.updatedAt,
          student: {
            fullName: registration.student?.fullName || artistInfo?.fullName || '',
            studentYear: registration.student?.studentYear || artistInfo?.batch || '',
            profilePicture: registration.student?.profilePicture || artistInfo?.profilePicture || null,
          },
          artwork: registration.artwork || {
            title: 'Untitled',
            category: '',
            medium: '',
            dimensions: '',
            description: '',
          },
          files: registration.files || [],
          storage: {
            provider: 'MEGA',
            state: defaultStatus,
            batch: batchName || '',
            artistId: registration.artistId || '',
            registrationId: registration.id || regFolder.name,
          },
        };
        output.push(fullReg);
      }
    }
  }

  output.sort((a, b) => {
    const aDate = a.updatedAt || a.createdAt || '';
    const bDate = b.updatedAt || b.createdAt || '';
    return String(bDate).localeCompare(String(aDate));
  });
  return output;
}

async function getAllRegistrations() {
  const storage = await getMegaInstance();
  if (!storage) return [];

  const rootFolder = (process.env.MEGA_ROOT_FOLDER || 'Fine Arts Exhibition').trim();
  let exhibitionRoot = storage.root.children?.find(c => c.name === rootFolder);
  if (!exhibitionRoot) exhibitionRoot = await storage.root.mkdir(rootFolder);

  const registeredRoot = await ensureMegaFolder(exhibitionRoot, 'Registered');
  const approvedRoot = await ensureMegaFolder(exhibitionRoot, 'Approved');

  const pending = await listMegaRegistrations(registeredRoot, 'Pending');
  const approved = await listMegaRegistrations(approvedRoot, 'Approved');
  return [...pending, ...approved];
}

function buildAdminData(registrations) {
  const summary = registrations.reduce(
    (acc, s) => {
      acc.total += 1;
      const st = String(s.status || '').toLowerCase();
      if (st === 'approved') acc.approved += 1;
      else if (st === 'rejected') acc.rejected += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, approved: 0, rejected: 0 }
  );
  return { summary, submissions: registrations };
}

// ── Main ──
if (process.argv[1] && process.argv[1].includes('buildAdminData')) {
  (async () => {
    const outputPath = process.argv[2] || 'admin-data.json';
    try {
      const registrations = await getAllRegistrations();
      const output = buildAdminData(registrations);
      await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
      console.log(`[buildAdminData] Wrote ${outputPath}`);
      console.log(`  Total: ${output.summary.total}  Pending: ${output.summary.pending}  Approved: ${output.summary.approved}  Rejected: ${output.summary.rejected}`);
    } catch (err) {
      console.error('[buildAdminData] Failed:', err.message);
      await fs.writeFile(outputPath, JSON.stringify({
        summary: { total: 0, pending: 0, approved: 0, rejected: 0 },
        submissions: [],
      }, null, 2));
    }
  })();
}

export { buildAdminData, getAllRegistrations };
