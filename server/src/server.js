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
const REGISTERED_ROOT = 'Registered';
const APPROVED_ROOT = 'Approved';
const YEAR_FOLDERS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'katuree';
const GITHUB_REPO = process.env.GITHUB_REPO || 'fine-arts-exhibition';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);

await fs.mkdir(UPLOAD_DIR, { recursive: true });
for (const rootName of [REGISTERED_ROOT, APPROVED_ROOT]) {
  for (const year of YEAR_FOLDERS) {
    await fs.mkdir(path.join(UPLOAD_DIR, rootName, year), { recursive: true });
  }
}
await fs.mkdir(path.join(UPLOAD_DIR, '.incoming'), { recursive: true });

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = path.join(UPLOAD_DIR, '.incoming');
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = safePathSegment(path.basename(file.originalname, ext), 'artwork').slice(0, 80);
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
app.use('/storage', express.static(UPLOAD_DIR));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'fine-arts-exhibition-api', githubConfigured: Boolean(GITHUB_TOKEN), uploadDir: UPLOAD_DIR });
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalArtworksRegistered = await countArtworkTitleFolders(path.join(UPLOAD_DIR, REGISTERED_ROOT));
    res.json({ ok: true, totalArtworksRegistered });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Stats failed' });
  }
});

app.post('/api/registrations', upload.array('artworkFiles', 10), async (req, res) => {
  try {
    if (!(req.files || []).length) return res.status(400).json({ error: 'At least one artwork file is required.' });

    const now = new Date().toISOString();
    const registrationId = `${now.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const category = req.body.category === 'Other' ? req.body.otherCategory : req.body.category;
    const yearFolder = normalizeYear(req.body.studentYear);
    const studentFolder = `${safePathSegment(req.body.rollNumber, 'No Roll No')} - ${safePathSegment(req.body.fullName, 'Unnamed Student')}`;
    const artworkFolder = safePathSegment(req.body.artworkTitle, 'Untitled Artwork');
    const targetDir = path.join(UPLOAD_DIR, REGISTERED_ROOT, yearFolder, studentFolder, artworkFolder);
    await fs.mkdir(targetDir, { recursive: true });

    const files = [];
    for (const file of req.files || []) {
      const finalPath = await uniqueDestination(targetDir, file.originalname);
      await fs.rename(file.path, finalPath);
      const rel = path.relative(UPLOAD_DIR, finalPath).replace(/\\/g, '/');
      files.push({
        originalName: file.originalname,
        storedName: path.basename(finalPath),
        mimeType: file.mimetype,
        size: file.size,
        megaSyncPath: rel,
        url: `${PUBLIC_BASE_URL}/storage/${rel.split('/').map(encodeURIComponent).join('/')}`,
      });
    }

    const registration = {
      id: registrationId,
      status: 'registered',
      createdAt: now,
      storage: {
        root: REGISTERED_ROOT,
        yearFolder,
        studentFolder,
        artworkFolder,
        megaSyncPath: path.relative(UPLOAD_DIR, targetDir).replace(/\\/g, '/'),
      },
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

    await fs.writeFile(path.join(targetDir, 'registration-info.json'), JSON.stringify(registration, null, 2), 'utf-8');

    let github = null;
    if (GITHUB_TOKEN) github = await saveRegistrationToGitHub(registrationId, registration);

    res.status(201).json({ ok: true, id: registrationId, registration, github });
  } catch (error) {
    await cleanupIncoming(req.files || []);
    console.error(error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});


function normalizeYear(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('1')) return '1st Year';
  if (text.includes('2')) return '2nd Year';
  if (text.includes('3')) return '3rd Year';
  if (text.includes('4')) return '4th Year';
  const direct = YEAR_FOLDERS.find((year) => year.toLowerCase() === text.trim());
  return direct || 'Unknown Year';
}

function safePathSegment(value, fallback) {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

async function uniqueDestination(dir, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = safePathSegment(path.basename(originalName, ext), 'artwork');
  let candidate = path.join(dir, `${base}${ext}`);
  for (let index = 2; ; index += 1) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base}-${index}${ext}`);
    } catch {
      return candidate;
    }
  }
}

async function cleanupIncoming(files) {
  await Promise.all(files.map(async (file) => {
    try {
      await fs.unlink(file.path);
    } catch {
      // Ignore cleanup errors.
    }
  }));
}

async function countArtworkTitleFolders(registeredDir) {
  let total = 0;
  let yearEntries = [];
  try {
    yearEntries = await fs.readdir(registeredDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  for (const yearEntry of yearEntries) {
    if (!yearEntry.isDirectory()) continue;
    const yearDir = path.join(registeredDir, yearEntry.name);
    const studentEntries = await fs.readdir(yearDir, { withFileTypes: true });

    for (const studentEntry of studentEntries) {
      if (!studentEntry.isDirectory()) continue;
      const studentDir = path.join(yearDir, studentEntry.name);
      const artworkEntries = await fs.readdir(studentDir, { withFileTypes: true });
      total += artworkEntries.filter((entry) => entry.isDirectory()).length;
    }
  }

  return total;
}

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
