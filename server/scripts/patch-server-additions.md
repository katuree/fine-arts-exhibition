# Server.js changes needed

## 1. Add publishAdminDataToGitHub function (after publishStatsToGitHub)

Insert AFTER the publishStatsToGitHub function in server.js:

```javascript
// ── Publish admin-data.json to GitHub ──
async function publishAdminDataToGitHub() {
  try {
    const { buildAdminData } = await import('./scripts/buildAdminData.js');
    const data = buildAdminData();
    const json = JSON.stringify(data, null, 2);

    // Write to local file
    const outputPath = path.resolve(ROOT_DIR, 'admin-data.json');
    await fsp.writeFile(outputPath, json, 'utf8');
    console.log('[publishAdminDataToGitHub] Wrote admin-data.json locally');

    // Push to GitHub via gh CLI
    await execFile('git', ['-C', ROOT_DIR, 'add', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, '-c', 'user.name=exhibition-bot -c user.email=bot@exhibition', 'commit', '-m', 'chore: update admin-data.json', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, 'push', 'origin', 'main']);
    console.log('[publishAdminDataToGitHub] Pushed admin-data.json to GitHub');
  } catch (err) {
    console.error('[publishAdminDataToGitHub] Failed:', err.message);
    // Non-fatal — admin-data.json is a fallback only
  }
}
```

Also add the import at the top of server.js:

```javascript
import { execFile } from 'child_process';
```

(Add to existing import statement if there is one, or add a new import line.)

## 2. Call publishAdminDataToGitHub() after each registration write

### After POST /api/registrations (around line ~430, in the response handler):
Add BEFORE the `}` that closes the response:
```javascript
publishAdminDataToGitHub();
```

### After PUT /api/registrations/:id (around line ~550):
Add before the `}` closing the PUT handler:
```javascript
publishAdminDataToGitHub();
```

### After review PATCH handler:
Add before the `}` closing the PATCH handler:
```javascript
publishAdminDataToGitHub();
```

## 3. Add manual rebuild endpoint

Add BEFORE the `app.listen(...)` line:

```javascript
app.get('/api/admin-data/build', async (req, res) => {
  try {
    await publishAdminDataToGitHub();
    res.json({ ok: true, message: 'admin-data.json rebuilt and pushed to GitHub.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
```
