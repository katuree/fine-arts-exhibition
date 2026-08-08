# TrueNAS + MEGA Setup for Fine Arts Exhibition

Goal:

- GitHub hosts the website and registration metadata.
- TrueNAS receives uploads and stores image/PDF files in a MEGA sync folder.
- MEGA syncs the files to mega.nz without keeping the Windows PC on.

## 1. Install MEGA on TrueNAS

In the already-open TrueNAS Chrome tab:

1. Go to Apps -> Available Apps.
2. Search for `MEGA`, `MEGAcmd`, or `MegaSync`.
3. Install the app if it exists.
4. Configure its sync folder/dataset, for example:
   `/mnt/tank/mega/fine-arts-exhibition`

If MEGA is not available in Apps, use a custom Docker app for MEGAcmd or use another always-on storage app. The registration API only needs a normal folder path mounted at `/data/uploads`.

## 2. Deploy the registration API on TrueNAS

Use the compose file in:

`server/docker-compose.yml`

Important volume line:

```yaml
- /mnt/tank/mega/fine-arts-exhibition:/data/uploads
```

Change `/mnt/tank/mega/fine-arts-exhibition` to the real MEGA sync folder path on your TrueNAS.

The API will run on:

`http://192.168.1.45:8088`

## 3. GitHub token

The API needs to write registration JSON files to this repo:

`https://github.com/katuree/fine-arts-exhibition`

Create a GitHub token with repo contents write access and paste it only into the TrueNAS app environment variable:

`GITHUB_TOKEN`

Do not paste the token into chat.

Other environment variables:

```text
GITHUB_OWNER=katuree
GITHUB_REPO=fine-arts-exhibition
GITHUB_BRANCH=main
PUBLIC_BASE_URL=http://192.168.1.45:8088
MAX_FILE_MB=50
```

## 4. Verify

After deploying the API:

```bash
curl http://192.168.1.45:8088/api/health
```

Expected:

```json
{
  "ok": true,
  "service": "fine-arts-exhibition-api",
  "githubConfigured": true
}
```

## 5. Important public-site note

The GitHub Pages website is HTTPS:

`https://katuree.github.io/fine-arts-exhibition/`

Browsers block HTTPS pages from uploading to a plain HTTP API. For public student registration, the TrueNAS API must also be exposed over HTTPS, preferably with Cloudflare Tunnel.

Until HTTPS is configured for the API, test the registration form from LAN using a local/static HTTP copy or by serving the site from TrueNAS.
