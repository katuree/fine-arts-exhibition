# Patch server.js: Add publishAdminDataToGitHub()

## 1. Add import at top of server.js

Add this line to the import statements:
```javascript
import { execFile } from 'child_process';
```

## 2. Add publishAdminDataToGitHub() function

Insert AFTER the existing `publishStatsToGitHub()` function in server.js:

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

    // Push to GitHub
    await execFile('git', ['-C', ROOT_DIR, 'add', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, '-c', 'user.name=exhibition-bot -c user.email=bot@exhibition', 'commit', '-m', 'chore: update admin-data.json', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, 'push', 'origin', 'main']);
    console.log('[publishAdminDataToGitHub] Pushed admin-data.json to GitHub');
  } catch (err) {
    console.error('[publishAdminDataToGitHub] Failed:', err.message);
  }
}
```

## 3. Call publishAdminDataToGitHub() after each registration write

### After POST /api/registrations (in the finally block or after the response):
```javascript
publishAdminDataToGitHub();
```

### After PUT /api/registrations/:id:
```javascript
publishAdminDataToGitHub();
```

### After review PATCH handler:
```javascript
publishAdminDataToGitHub();
```

## 4. Add manual rebuild endpoint

Before the `app.listen(...)` line:

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
