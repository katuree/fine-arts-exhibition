# Deploy the Fine Arts Exhibition API on TrueNAS

## Problem
The Cloudflare tunnel (`fine-arts-api-tunnel`) forwards traffic from `https://finearts-api.katuree.com` → `http://192.168.1.45:8088`, but **nothing is listening on port 8088**. The Express API server (`server.js`) needs to be deployed as a Docker container.

## Files in this directory

### `docker-compose.yml`
Deploy the API server. Creates `fine-arts-api` container on port 8080 with MEGA integration.

### `Dockerfile`
Existing — builds from `node:22-alpine`, copies `src/server.js`.

### `scripts/buildAdminData.js`
Script to scan `/data/uploads/Registered/` for all `artwork-info.json` files and build `admin-data.json` for the GitHub Pages admin dashboard.

## Steps to deploy on TrueNAS

### Step 1: Upload files to TrueNAS
Copy these files to `/mnt/Pool/fine-arts-api/`:
- `docker-compose.yml`
- `Dockerfile`
- `src/server.js` (from your local repo)
- `package.json` and `package-lock.json` (from your local repo)
- `node_modules/` (or run `npm install` inside the container)

### Step 2: Build and start
```bash
cd /mnt/Pool/fine-arts-api
docker compose up -d --build
```

### Step 3: Verify the API is running
```bash
# Check container is up
docker ps | grep fine-arts-api

# Check logs
docker logs fine-arts-api --tail 20

# Test health endpoint (from local machine)
curl http://192.168.1.45:8080/api/health

# Test through Cloudflare tunnel (from local machine)
curl https://finearts-api.katuree.com/api/health
```

### Step 4: Seed admin-data.json
```bash
# Run the build script once to seed admin-data.json
docker exec fine-arts-api node /app/scripts/buildAdminData.js /app/admin-data.json
```

### Step 5: Add `publishAdminDataToGitHub()` to server.js
See `patch-server-additions.md` in `server/scripts/` for the code to add.
After deploying, add the `publishAdminDataToGitHub()` function and call it from POST/PUT/PATCH handlers.

### Step 6: Verify admin.html works
Open `https://katuree.github.io/fine-arts-exhibition/admin.html` in a browser.
The dashboard should now fetch real registration data from the API.

## Troubleshooting

### Tunnel still shows "Unable to reach the origin service"
- Check API container is running: `docker ps | grep fine-arts-api`
- Check API is listening: `docker exec fine-arts-api curl -s http://localhost:8080/api/health`
- Verify tunnel config points to port 8080 (not 8088) — the tunnel is currently configured to `192.168.1.45:8088` but the API runs on 8080. Update the tunnel config or set `PORT=8088` in the environment.

### MEGA connection fails
- Check MEGA_EMAIL and MEGA_PASSWORD env vars are set
- Check `MEGA_ROOT_FOLDER` matches your MEGA folder name
- Check the `megacmd` container can reach MEGA: `docker logs megacmd --tail 10`

### Port conflict
- The tunnel forwards to `192.168.1.45:8088` (set in the tunnel config)
- The API defaults to port 8080
- **Fix**: Set `PORT=8088` in docker-compose.yml environment, OR update the tunnel config to point to port 8080

## Quick fix: Update PORT to 8088
In `docker-compose.yml`, change the PORT env var:
```yaml
- PORT=8088
```
Or change the tunnel config from `192.168.1.45:8088` to `192.168.1.45:8080`.
