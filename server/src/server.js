import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Octokit } from '@octokit/rest';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'katuree';
const GITHUB_REPO = process.env.GITHUB_REPO || 'fine-arts-exhibition';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(path.join(UPLOAD_DIR, 'registrations'), { recursive: true });
await fs.mkdir(path.join(UPLOAD_DIR, 'files'), { recursive: true });

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dir = path.join(UPLOAD_DIR, 'files', today);
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artwork';
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  },
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use('/files', express.static(path.join(UPLOAD_DIR, 'files')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'fine-arts-exhibition-api', githubConfigured: Boolean(GITHUB_TOKEN), uploadDir: UPLOAD_DIR });
});

app.post('/api/registrations', upload.array('artworkFiles', 10), async (req, res) => {
  try {
    const files = (req.files || []).map((file) => {
      const rel = path.relative(UPLOAD_DIR, file.path).replace(/\\/g, '/');
      return {
        originalName: file.originalname,
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        megaSyncPath: rel,
        url: `${PUBLIC_BASE_URL}/${rel}`,
      };
    });

    if (!files.length) return res.status(400).json({ error: 'At least one artwork file is required.' });

    const now = new Date().toISOString();
    const registrationId = `${now.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const category = req.body.category === 'Other' ? req.body.otherCategory : req.body.category;

    const registration = {
      id: registrationId,
      status: 'pending',
      createdAt: now,
      student: {
        fullName: req.body.fullName || '',
        rollNumber: req.body.rollNumber || '',
        studentYear: req.body.studentYear || '',
      },
      artwork: {
        title: req.body.artworkTitle || '',
        category: category || '',
        medium: req.body.medium || '',
        dimensions: req.body.dimensions || '',
        description: req.body.description || '',
      },
      files,
    };

    const localMetaPath = path.join(UPLOAD_DIR, 'registrations', `${registrationId}.json`);
    await fs.writeFile(localMetaPath, JSON.stringify(registration, null, 2), 'utf-8');

    let github = null;
    if (GITHUB_TOKEN) github = await saveRegistrationToGitHub(registrationId, registration);

    res.status(201).json({ ok: true, id: registrationId, registration, github });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

async function saveRegistrationToGitHub(id, registration) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const filePath = `registrations/${id}.json`;
  const content = Buffer.from(JSON.stringify(registration, null, 2)).toString('base64');
  const result = await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: filePath,
    message: `Add artwork registration ${id}`,
    content,
    branch: GITHUB_BRANCH,
  });
  return { path: filePath, htmlUrl: result.data.content?.html_url, commitUrl: result.data.commit?.html_url };
}

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Bad request' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fine Arts Exhibition API listening on 0.0.0.0:${PORT}`);
});
