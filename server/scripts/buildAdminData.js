/**
 * buildAdminData.js
 * Calls the local /api/registrations endpoint to get registration data
 * and builds admin-data.json for the GitHub Pages admin dashboard.
 */

import path from 'path';
import fs from 'fs/promises';

function normalizeReviewStatus(status) {
  if (!status) return 'Pending';
  const s = String(status).toLowerCase().trim();
  if (s === 'approved' || s === 'accept') return 'Approved';
  if (s === 'rejected' || s === 'reject') return 'Rejected';
  return 'Pending';
}

async function getRegistrations() {
  try {
    const resp = await fetch('http://localhost:8088/api/registrations');
    const data = await resp.json();
    return (data.registrations || []).map(r => ({
      ...r,
      status: normalizeReviewStatus(r.reviewStatus || r.status),
    }));
  } catch (err) {
    console.error('[buildAdminData] API call failed:', err.message);
  }
  return [];
}

// Exported function called by server.js publishAdminDataToGitHub
export async function buildAdminData() {
  const registrations = await getRegistrations();
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

// CLI entry point — only when run directly
if (process.argv[1] && process.argv[1].endsWith('buildAdminData.js')) {
  (async () => {
    const data = await buildAdminData();
    const outputPath = process.argv[2] || 'admin-data.json';
    await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
    console.log(`[buildAdminData] Wrote ${outputPath}`);
    console.log(`  Total: ${data.summary.total}  Pending: ${data.summary.pending}  Approved: ${data.summary.approved}  Rejected: ${data.summary.rejected}`);
  })();
}
