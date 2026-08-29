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
  // Use Node's built-in fetch (no curl dependency needed)
  try {
    const resp = await fetch('http://localhost:8088/api/registrations');
    const data = await resp.json();
    if (data.registrations) {
      return data.registrations.map(r => ({
        ...r,
        status: normalizeReviewStatus(r.reviewStatus || r.status),
      }));
    }
  } catch (err) {
    console.error('[buildAdminData] API call failed:', err.message);
  }
  return [];
}

export function buildAdminData() {
  return { summary: { total: 0, pending: 0, approved: 0, rejected: 0 }, submissions: [] };
}

// If run directly, call the API and build
if (process.argv[1] && process.argv[1].includes('buildAdminData')) {
  (async () => {
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

    const output = { summary, submissions: registrations };
    const outputPath = process.argv[2] || 'admin-data.json';
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
    console.log(`[buildAdminData] Wrote ${outputPath}`);
    console.log(`  Total: ${summary.total}  Pending: ${summary.pending}  Approved: ${summary.approved}  Rejected: ${summary.rejected}`);
  })();
}
