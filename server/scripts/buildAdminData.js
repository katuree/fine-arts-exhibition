/**
 * buildAdminData.js
 * Reads all registration artwork-info.json files from LOCAL_STORAGE_DIR/Registered/
 * and builds admin-data.json for the GitHub Pages admin dashboard.
 *
 * Usage:
 *   node server/scripts/buildAdminData.js [outputPath]
 *   # outputPath defaults to ../../admin-data.json (project root)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const LOCAL_STORAGE_DIR = process.env.UPLOAD_DIR || path.resolve(ROOT_DIR, 'data/uploads');
const OUTPUT_PATH = process.argv[2] || path.resolve(ROOT_DIR, 'admin-data.json');

const BATCH_FOLDERS = [
  '2020 Batch', '2021 Batch', '2022 Batch',
  '2023 Batch', '2024 Batch', '2025 Batch',
];

function buildAdminData() {
  const submissions = [];
  const registeredDir = path.join(LOCAL_STORAGE_DIR, 'Registered');

  if (!fs.existsSync(registeredDir)) {
    console.log('[buildAdminData] Registered dir not found, returning empty.');
    return { summary: { total: 0, pending: 0, approved: 0, rejected: 0 }, submissions: [] };
  }

  for (const batch of BATCH_FOLDERS) {
    const batchDir = path.join(registeredDir, batch);
    if (!fs.existsSync(batchDir)) continue;

    // Scan artist folders
    const artistDirs = fs.readdirSync(batchDir).filter(f => {
      const fp = path.join(batchDir, f);
      return fs.statSync(fp).isDirectory();
    });

    for (const artistDir of artistDirs) {
      // Scan registration folders within each artist
      const regDirs = fs.readdirSync(path.join(batchDir, artistDir)).filter(f => {
        const fp = path.join(batchDir, artistDir, f);
        return fs.statSync(fp).isDirectory();
      });

      for (const regDir of regDirs) {
        const infoPath = path.join(batchDir, artistDir, regDir, 'artwork-info.json');
        if (!fs.existsSync(infoPath)) continue;

        try {
          const reg = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          submissions.push({
            id: reg.id,
            artistId: reg.artistId || artistDir,
            student: reg.student?.fullName || 'Unknown',
            artwork: reg.artwork?.title || 'Untitled',
            department: reg.artwork?.category || 'Fine Arts',
            status: reg.status || 'Pending',
            imageUrl: reg.files?.[0]?.url || '',
            fileName: reg.files?.[0]?.originalName || '',
            medium: reg.artwork?.medium || '—',
            dimensions: reg.artwork?.dimensions || '—',
            description: reg.artwork?.description || '',
            batch,
            createdAt: reg.createdAt,
            updatedAt: reg.updatedAt,
          });
        } catch (e) {
          console.warn(`[buildAdminData] Failed to parse ${infoPath}:`, e.message);
        }
      }
    }
  }

  // Sort by updatedAt descending
  submissions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const summary = submissions.reduce(
    (acc, s) => {
      acc.total += 1;
      const status = String(s.status).toLowerCase();
      if (status === 'approved') acc.approved += 1;
      else if (status === 'rejected') acc.rejected += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, approved: 0, rejected: 0 }
  );

  return { summary, submissions };
}

// If run directly (not imported), execute
if (process.argv[1] === __filename || !module.parent) {
  const data = buildAdminData();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(OUTPUT_PATH, json, 'utf8');
  console.log('[buildAdminData] Wrote', OUTPUT_PATH);
  console.log('  Total:', data.summary.total, 'Pending:', data.summary.pending,
              'Approved:', data.summary.approved, 'Rejected:', data.summary.rejected);
  console.log('  Submissions:', data.submissions.length);
}

export { buildAdminData };
