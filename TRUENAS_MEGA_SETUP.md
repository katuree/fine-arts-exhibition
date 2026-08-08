# TrueNAS + Syncthing Setup for Fine Arts Exhibition

Goal:

- GitHub hosts the website and registration metadata.
- TrueNAS receives artwork uploads and stores files in a dataset.
- Syncthing on TrueNAS syncs those files to your Windows PC
  (no cloud account needed, no always-on PC needed).

## 1. Confirm the dataset

In TrueNAS (already open in Chrome):

1. Datasets -> Pool/data -> `fine-arts-exhibition`.
   Dataset path: `/mnt/tank/data/fine-arts-exhibition`.
2. Inside it, a `files/` folder will be created automatically by
   the registration API.

If you don't see this dataset yet, create it under Pool/data with
the name `fine-arts-exhibition` (Generic preset).

## 2. Deploy Syncthing

Two routes:

### Route A: TrueNAS Custom App (recommended)

1. Apps -> Discover -> Custom App.
2. Choose "Use Docker Compose".
3. Paste the contents of `truenas-deploy/docker-compose.yml`
   from the GitHub repo.

### Route B: Install Syncthing from the catalog

1. Apps -> Discover -> search "Syncthing".
2. Click Install.
3. In "Syncthing Config Storage", leave as ixVolume.
4. In "Additional Storage", add:
   - Host Path: `/mnt/tank/data/fine-arts-exhibition`
   - Mount Path: `/data`
5. Install.

## 3. Open Syncthing Web UI

After install:

```text
http://192.168.1.45:8384
```

The Syncthing API key is in the Syncthing app config on TrueNAS.

## 4. Pair with the Windows PC

On the Windows PC:

1. Install Syncthing from https://syncthing.net/downloads/.
2. Open its Web UI (default http://127.0.0.1:8384).
3. Note the Device ID (Actions -> Show Device ID).
4. In the TrueNAS Syncthing Web UI, click Add Remote Device,
   paste the Windows Device ID.
5. Add a folder on TrueNAS:
   - Folder Path: `/data/files`
   - Folder ID: `files`
   - Share with the Windows device.
6. On Windows Syncthing, accept the share and set the local
   folder (for example `G:\Fine-Arts-Exhibition-Uploads`).

Now artwork files uploaded by students will appear on your PC
automatically, even if your PC was off when the upload happened.

## 5. Deploy the registration API (next step)

The API server lives in `server/` and is what receives HTTP
uploads from the public website.

1. In TrueNAS, Apps -> Discover -> Custom App.
2. Use Docker Compose and paste
   `server/docker-compose.yml` from the GitHub repo.
3. Edit the volume line so it points at the same dataset:

   ```yaml
   - /mnt/tank/data/fine-arts-exhibition:/data/uploads
   ```

4. Set environment variables:
   - `GITHUB_OWNER=katuree`
   - `GITHUB_REPO=fine-arts-exhibition`
   - `GITHUB_BRANCH=main`
   - `PUBLIC_BASE_URL=http://192.168.1.45:8088`
   - `MAX_FILE_MB=50`
   - `GITHUB_TOKEN=<paste your GitHub token here, only inside TrueNAS>`
5. Install. API will run on `http://192.168.1.45:8088`.

## 6. Important public-site note

The GitHub Pages site is HTTPS:
https://katuree.github.io/fine-arts-exhibition/

Browsers block HTTPS pages from uploading to plain HTTP APIs.
For public student registration, the API must be exposed via
HTTPS, ideally with Cloudflare Tunnel, not by exposing the
TrueNAS admin UI.

Until then, test the registration form locally or by serving
the site from the same TrueNAS instance.
