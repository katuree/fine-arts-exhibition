# Fine Arts Exhibition API for TrueNAS + MEGA

This API runs on TrueNAS and receives artwork registrations.

It does two things:

1. Saves uploaded image/PDF files into `/data/uploads`.
   Mount that path to the MEGA sync folder/dataset on TrueNAS.
2. Saves text registration metadata into GitHub under `registrations/*.json`.

## Required environment variables

- `GITHUB_TOKEN` — GitHub token with repo contents write access. Type this only inside TrueNAS UI; do not paste it into chat.
- `GITHUB_OWNER` — `katuree`
- `GITHUB_REPO` — `fine-arts-exhibition`
- `GITHUB_BRANCH` — `main`
- `PUBLIC_BASE_URL` — API URL, e.g. `http://192.168.1.45:8088`

## Docker compose

Edit the volume path in `docker-compose.yml` so the host path points to your TrueNAS MEGA sync folder:

```yaml
- /mnt/tank/mega/fine-arts-exhibition:/data/uploads
```

Then deploy it as a TrueNAS custom app / compose app.

Health check:

```bash
curl http://192.168.1.45:8088/api/health
```
