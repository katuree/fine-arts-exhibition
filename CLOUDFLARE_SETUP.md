# Fine Arts Exhibition - Cloudflare Setup

## Quick Setup

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Create R2 Bucket
```bash
cd worker
wrangler r2 bucket create fine-arts-exhibition
```

### 4. Set Admin Password (as secret)
```bash
wrangler secret put ADMIN_PASSWORD
# Enter a strong password when prompted
```

### 5. Deploy Worker
```bash
wrangler deploy
```

### 6. Update register.html
Replace the API endpoint in register.html with your Worker URL:
```javascript
const WORKER_URL = 'https://fine-arts-exhibition.your-subdomain.workers.dev';
```

## Architecture

```
Student fills register.html
    ↓
Browser requests presigned URL from Worker (/api/presign-upload)
    ↓
Worker generates signed PUT URL for R2
    ↓
Browser uploads file directly to R2 (bypasses Worker)
    ↓
Student submits form with R2 key + metadata
    ↓
Worker copies file to artworks/ + saves metadata
    ↓
Admin panel: approve/reject artworks
    ↓
Public gallery loads approved artworks from R2
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/presign-upload | Get presigned upload URL |
| GET | /api/artworks | List artworks (public) |
| GET | /api/artworks/:id | Get single artwork |
| POST | /api/artworks | Create artwork metadata (after upload) |
| PUT | /api/artworks/:id | Update artwork (approve/reject) |
| DELETE | /api/artworks/:id | Delete artwork |
| POST | /api/admin/login | Admin login |

## Free Tier Limits

- 10 GB storage
- 1M Class A operations/month (uploads, writes)
- 10M Class B operations/month (reads, downloads)
- $0 egress bandwidth