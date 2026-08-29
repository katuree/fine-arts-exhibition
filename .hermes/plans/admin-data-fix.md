# Plan: Fix admin-data.json + admin.html API fetch

## Bug Summary
1. `admin-data.json` is hardcoded empty (`"submissions": []`) — nobody builds it
2. `admin.html` reads static `admin-data.json` — never gets real data
3. `stats.json` shows 0 because the server's `UPLOAD_DIR` doesn't match where artwork folders actually are

## Fix 1: Build admin-data.json from local registrations (server-side)
### New file: `server/scripts/buildAdminData.js`
- Scans `LOCAL_STORAGE_DIR/Registered/` for batch folders
- For each batch, scans artist folders (by artistId), then registration folders
- Reads each `artwork-info.json`, extracts: id, artistId, student.name, artwork.title, category, status, imageUrl
- Builds `{ summary: {total, pending, approved, rejected}, submissions: [...] }`
- Publishes to GitHub via `publishAdminDataToGitHub()` (mirrors `publishStatsToGitHub`)

### Server integration (`server.js`):
- Add `publishAdminDataToGitHub()` helper
- Call `buildAdminData()` at end of POST `/api/registrations` (new registration)
- Call `buildAdminData()` at end of PUT `/api/registrations/:id` (update)
- Call `buildAdminData()` at end of review PATCH (approve/reject)
- Add manual `GET /api/admin-data/build` endpoint to trigger rebuild

## Fix 2: Make admin.html fetch from API (client-side)
### Change `admin.html` `loadDashboardData()`:
- First try: `fetch(`${API_URL}/api/registrations`)` → populate dashboard
- Fallback: `fetch('./admin-data.json?v=...')` → use static data
- Update `hydrateLiveRegistrationStatuses()` to be a no-op (already handled by primary fetch)
- Update `renderRegistrations()` to use `item.artistId` under artist name
- Add "Artist ID" column to table header

## Fix 3: stats.json count fix
- The `countArtworkTitleFolders` function counts directories in `UPLOAD_DIR/Registered/`
- If it returns 0, it means the server container's `UPLOAD_DIR` doesn't match where registrations are actually stored
- This is a deployment/config issue — the server needs the correct `UPLOAD_DIR` env var pointing to the TrueNAS mount

## Files changed:
1. `server/scripts/buildAdminData.js` (new)
2. `server/src/server.js` (add publish function + trigger calls)
3. `admin.html` (fetch from API + artist ID column)
4. `admin-data.json` (seed with current registrations from local folder)

## Verification:
1. Deploy to server, trigger a new registration → check admin-data.json is populated
2. Open admin.html → verify registrations display
3. Check stats.json reflects actual count
