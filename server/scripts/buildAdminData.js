/**
 * buildAdminData.js
 * Scans MEGA for all registrations and builds admin-data.json.
 * This mirrors the logic in server.js listMegaRegistrationsFromRoot.
 */

import { Storage } from 'megajs';
import path from 'path';
import crypto from 'crypto';

const BATCH_FOLDERS = [
  '2020 Batch', '2021 Batch', '2022 Batch',
  '2023 Batch', '2024 Batch', '2025 Batch',
];

function normalizeBatch(batch) {
  if (!batch) return null;
  const str = String(batch).trim().toLowerCase();
  for (const b of BATCH_FOLDERS) {
    if (b.toLowerCase().replace(/\s/g, '') === str.replace(/\s/g, '')) return b;
  }
  // Try to match by year prefix
  const yearMatch = str.match(/(\d{4})/);
  if (yearMatch) {
    const year = yearMatch[1];
    const candidate = `${year} Batch`;
    if (BATCH_FOLDERS.includes(candidate)) return candidate;
  }
  return null;
}

function normalizeIdentityName(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/[^\w\s]/g, '');
}

function normalizeReviewStatus(status) {
  if (!status) return 'Pending';
  const s = String(status).toLowerCase().trim();
  if (s === 'approved' || s === 'accept') return 'Approved';
  if (s === 'rejected' || s === 'reject') return 'Rejected';
  return 'Pending';
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
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return ext;
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function buildRegistrationFromMegaNode(registrationFolder, defaultStatus, artistInfo) {
  const infoPath = path.join(registrationFolder.name, 'artwork-info.json');
  const megaFile = mega?.files?.[registrationFolder.nodeId || registrationFolder.name];
  // Read from MEGA filesystem
  const name = registrationFolder.name;
  const parts = name.split('/');
  const regId = parts[parts.length - 1];

  return {
    id: regId,
    artistId: artistInfo?.artistId || '',
    status: defaultStatus,
    student: {
      fullName: artistInfo?.fullName || '',
      studentYear: artistInfo?.batch || '',
      profilePicture: artistInfo?.profilePicture || null,
    },
    artwork: {
      title: 'Untitled',
      category: '',
      medium: '',
      dimensions: '',
      description: '',
    },
    files: [],
    storage: {
      provider: 'MEGA',
      state: 'Registered',
      batch: '',
      artistId: artistInfo?.artistId || '',
      registrationId: regId,
    },
  };
}

// Global mega instance
let mega = null;

async function getMegaInstance() {
  if (mega) return mega;
  const EMAIL = process.env.MEGA_EMAIL || '';
  const PASSWORD = process.env.MEGA_PASSWORD || '';
  if (!EMAIL || !PASSWORD) return null;

  mega = await new Storage({ email: EMAIL, password: PASSWORD }).ready();
  return mega;
}

async function listMegaRegistrations(defaultStatus) {
  const output = [];
  const storage = await getMegaInstance();
  if (!storage) return output;

  mega = storage;
  const ROOT_FOLDER = process.env.MEGA_ROOT_FOLDER || 'Fine Arts Exhibition';

  let exhibitionRoot = mega.root.children?.find(c => c.name === ROOT_FOLDER);
  if (!exhibitionRoot) {
    exhibitionRoot = await mega.root.mkdir(ROOT_FOLDER);
  }

  const registeredRoot = await ensureMegaFolder(exhibitionRoot, 'Registered');
  if (!registeredRoot) return output;

  for (const batchFolder of registeredRoot.children || []) {
    if (!batchFolder.directory) continue;
    for (const artistFolder of batchFolder.children || []) {
      if (!artistFolder.directory) continue;
      // Read artist-info.json
      let artistInfo = null;
      try {
        const artistFile = artistFolder.children?.find(c => c.name === 'artist-info.json');
        if (artistFile) {
          const stream = artistFile.download();
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          artistInfo = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      } catch {}

      for (const regFolder of artistFolder.children || []) {
        if (!regFolder.directory) continue;
        let registration = null;
        try {
          const regFile = regFolder.children?.find(c => c.name === 'artwork-info.json');
          if (regFile) {
            const stream = regFile.download();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunks);
            const content = Buffer.concat(chunks).toString('utf8');
            registration = JSON.parse(content);
          }
        } catch {}

        if (!registration) continue;

        const fullReg = {
          id: registration.id || regFolder.name,
          artistId: registration.artistId || artistInfo?.artistId || '',
          status: registration.status || defaultStatus,
          createdAt: registration.createdAt,
          updatedAt: registration.updatedAt,
          student: registration.student || artistInfo?.student || {
            fullName: artistInfo?.fullName || 'Unknown',
            studentYear: artistInfo?.batch || '',
            profilePicture: artistInfo?.profilePicture || null,
          },
          artwork: registration.artwork || {
            title: 'Untitled',
            category: '',
            medium: '',
            dimensions: '',
            description: '',
          },
          files: registration.files || [],
          storage: registration.storage || {
            provider: 'MEGA',
            state: 'Registered',
            batch: normalizeBatch(batchFolder.name) || '',
            artistId: artistInfo?.artistId || '',
            registrationId: registration.id || regFolder.name,
          },
        };
        output.push(fullReg);
      }
    }
  }

  output.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return output;
}

async function ensureMegaFolder(parent, name) {
  let child = parent.children?.find(c => c.name === name);
  if (child) return child;
  return await parent.mkdir(name);
}

function hydrateRegistration(reg, artistInfo) {
  if (artistInfo?.profilePicture) {
    reg.student = {
      ...reg.student,
      profilePicture: artistInfo.profilePicture,
    };
  }
  return reg;
}

export function buildAdminData() {
  return { summary: { total: 0, pending: 0, approved: 0, rejected: 0 }, submissions: [] };
}

// If run directly, connect to MEGA and build
if (process.argv[1] && process.argv[1].includes('buildAdminData')) {
  (async () => {
    try {
      const registrations = await listMegaRegistrations('Pending');
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

      const output = { summary, submissions: registrations };
      const outputPath = process.argv[2] || 'admin-data.json';
      const fs = await import('fs');
      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(`[buildAdminData] Wrote ${outputPath}`);
      console.log(`  Total: ${summary.total}  Pending: ${summary.pending}  Approved: ${summary.approved}  Rejected: ${summary.rejected}`);
    } catch (err) {
      console.error('[buildAdminData] Failed:', err.message);
      // Write empty on failure
      const fs = await import('fs');
      fs.writeFileSync(outputPath || 'admin-data.json', JSON.stringify({
        summary: { total: 0, pending: 0, approved: 0, rejected: 0 },
        submissions: [],
      }, null, 2));
    }
  })();
}
