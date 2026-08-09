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
const STATS_PUBLISH_INTERVAL_SECONDS = Number(process.env.STATS_PUBLISH_INTERVAL_SECONDS || 300);
let lastPublishedStatsJson = '';
let statsPublishInFlight = false;

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const ROLL_NUMBER_PATTERN = /^Y\d{2}FA\d{4}$/;

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
  res.json({
    ok: true,
    service: 'fine-arts-exhibition-api',
    githubConfigured: Boolean(GITHUB_TOKEN),
    statsPublisherConfigured: Boolean(GITHUB_TOKEN),
    uploadDir: UPLOAD_DIR,
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json(await buildStats('api'));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Stats failed' });
  }
});

app.post('/api/registrations', upload.array('artworkFiles', 10), async (req, res) => {
  try {
    if (!(req.files || []).length) return res.status(400).json({ error: 'At least one artwork file is required.' });
    req.body.rollNumber = normalizeRollNumber(req.body.rollNumber);
    if (!isValidRollNumber(req.body.rollNumber)) {
      await cleanupIncoming(req.files || []);
      return res.status(400).json({ error: 'Enter a valid college roll number.' });
    }

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
      files.push(fileMetadata(file, finalPath));
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
    if (GITHUB_TOKEN) {
      github = await saveRegistrationToGitHub(registrationId, registration);
      await publishStatsToGitHub('registration');
    }

    res.status(201).json({ ok: true, id: registrationId, registration, github });
  } catch (error) {
    await cleanupIncoming(req.files || []);
    console.error(error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});


app.get('/api/registrations/:id', async (req, res) => {
  try {
    const found = await findRegistrationById(req.params.id);
    if (!found) return res.status(404).json({ error: 'Registration not found' });
    res.json({ ok: true, id: found.registration.id, registration: found.registration });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Registration lookup failed' });
  }
});

app.put('/api/registrations/:id', upload.array('artworkFiles', 10), async (req, res) => {
  try {
    const found = await findRegistrationById(req.params.id);
    if (!found) {
      await cleanupIncoming(req.files || []);
      return res.status(404).json({ error: 'Registration not found' });
    }

    const existing = found.registration;
    const now = new Date().toISOString();
    const category = req.body.category === 'Other' ? req.body.otherCategory : req.body.category;
    const rollNumber = normalizeRollNumber(req.body.rollNumber || existing.student?.rollNumber);
    if (!isValidRollNumber(rollNumber)) {
      await cleanupIncoming(req.files || []);
      return res.status(400).json({ error: 'Enter a valid college roll number.' });
    }
    req.body.rollNumber = rollNumber;
    const yearFolder = normalizeYear(req.body.studentYear || existing.student?.studentYear);
    const studentFolder = `${safePathSegment(rollNumber, 'No Roll No')} - ${safePathSegment(req.body.fullName || existing.student?.fullName, 'Unnamed Student')}`;
    const artworkFolder = safePathSegment(req.body.artworkTitle || existing.artwork?.title, 'Untitled Artwork');
    const targetDir = path.join(UPLOAD_DIR, REGISTERED_ROOT, yearFolder, studentFolder, artworkFolder);

    if (path.resolve(found.dir) !== path.resolve(targetDir)) {
      try {
        await fs.access(targetDir);
        await cleanupIncoming(req.files || []);
        return res.status(409).json({ error: 'Another registration already uses that year/student/artwork folder.' });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.rename(found.dir, targetDir);
    }

    let files = Array.isArray(existing.files) ? existing.files : [];
    const filesToRemove = parseFileRemovalList(req.body.removeExistingFiles);
    if ((req.files || []).length) {
      await removeArtworkFiles(targetDir);
      files = [];
      for (const file of req.files || []) {
        const finalPath = await uniqueDestination(targetDir, file.originalname);
        await fs.rename(file.path, finalPath);
        files.push(fileMetadata(file, finalPath));
      }
    } else {
      const remainingFiles = files.filter((file) => !shouldRemoveFile(file, filesToRemove));
      if (files.length && !remainingFiles.length) {
        await cleanupIncoming(req.files || []);
        return res.status(400).json({ error: 'At least one artwork file must remain. Upload a replacement before removing all existing files.' });
      }
      await removeSelectedArtworkFiles(targetDir, files, filesToRemove);
      files = remainingFiles.map((file) => {
        const finalPath = path.join(targetDir, file.storedName || file.originalName || 'artwork');
        const rel = path.relative(UPLOAD_DIR, finalPath).replace(/\\/g, '/');
        return {
          ...file,
          megaSyncPath: rel,
          url: `${PUBLIC_BASE_URL}/storage/${rel.split('/').map(encodeURIComponent).join('/')}`,
        };
      });
    }

    const registration = {
      ...existing,
      id: existing.id,
      status: existing.status || 'registered',
      createdAt: existing.createdAt,
      updatedAt: now,
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
        title: req.body.artworkTitle || existing.artwork?.title || '',
        category: category || existing.artwork?.category || '',
        medium: req.body.medium || existing.artwork?.medium || '',
        dimensions: optionalBodyValue(req.body, 'dimensions', existing.artwork?.dimensions || ''),
        description: optionalBodyValue(req.body, 'description', existing.artwork?.description || ''),
      },
      files,
    };

    await fs.writeFile(path.join(targetDir, 'registration-info.json'), JSON.stringify(registration, null, 2), 'utf-8');

    let github = null;
    if (GITHUB_TOKEN) {
      github = await saveRegistrationToGitHub(registration.id, registration, 'Update');
      await publishStatsToGitHub('registration-edit');
    }

    res.json({ ok: true, id: registration.id, registration, github });
  } catch (error) {
    await cleanupIncoming(req.files || []);
    console.error(error);
    res.status(500).json({ error: error.message || 'Registration update failed' });
  }
});


function fileMetadata(file, finalPath) {
  const rel = path.relative(UPLOAD_DIR, finalPath).replace(/\\/g, '/');
  return {
    originalName: file.originalname,
    storedName: path.basename(finalPath),
    mimeType: file.mimetype,
    size: file.size,
    megaSyncPath: rel,
    url: `${PUBLIC_BASE_URL}/storage/${rel.split('/').map(encodeURIComponent).join('/')}`,
  };
}

async function findRegistrationById(id) {
  const needle = String(id || '').trim();
  if (!needle) return null;
  const registeredDir = path.join(UPLOAD_DIR, REGISTERED_ROOT);
  const stack = [registeredDir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.name === 'registration-info.json') {
        try {
          const registration = JSON.parse(await fs.readFile(entryPath, 'utf-8'));
          if (registration.id === needle) return { registration, infoPath: entryPath, dir: path.dirname(entryPath) };
        } catch (error) {
          console.warn(`Skipping unreadable registration info ${entryPath}:`, error.message);
        }
      }
    }
  }

  return null;
}

async function removeArtworkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || entry.name === 'registration-info.json') return;
    await fs.unlink(path.join(dir, entry.name));
  }));
}


function parseFileRemovalList(value) {
  if (!value) return new Set();
  const rawValues = Array.isArray(value) ? value : [value];
  const names = [];
  for (const rawValue of rawValues) {
    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) names.push(...parsed);
      else names.push(parsed);
    } catch {
      names.push(rawValue);
    }
  }
  return new Set(names.map((name) => String(name || '').trim()).filter(Boolean));
}

function shouldRemoveFile(file, filesToRemove) {
  return filesToRemove.has(file.storedName) || filesToRemove.has(file.originalName) || filesToRemove.has(file.megaSyncPath);
}


function optionalBodyValue(body, key, fallback = '') {
  return Object.prototype.hasOwnProperty.call(body || {}, key) ? (body[key] || '') : fallback;
}


function normalizeRollNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidRollNumber(value) {
  return ROLL_NUMBER_PATTERN.test(normalizeRollNumber(value));
}

async function removeSelectedArtworkFiles(dir, files, filesToRemove) {
  if (!filesToRemove.size) return;
  await Promise.all(files.map(async (file) => {
    if (!shouldRemoveFile(file, filesToRemove)) return;
    const storedName = path.basename(file.storedName || file.originalName || '');
    if (!storedName || storedName === 'registration-info.json') return;
    try {
      await fs.unlink(path.join(dir, storedName));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
}


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

async function buildStats(source = 'api') {
  const totalArtworksRegistered = await countArtworkTitleFolders(path.join(UPLOAD_DIR, REGISTERED_ROOT));
  return {
    ok: true,
    totalArtworksRegistered,
    updatedAt: new Date().toISOString(),
    source,
  };
}

async function publishStatsToGitHub(source = 'periodic') {
  if (!GITHUB_TOKEN || statsPublishInFlight) return null;

  statsPublishInFlight = true;
  try {
    const stats = await buildStats(source);
    const statsJson = `${JSON.stringify(stats, null, 2)}
`;
    if (statsJson === lastPublishedStatsJson) return { skipped: true, reason: 'unchanged' };

    const result = await createOrUpdateGitHubFile({
      filePath: 'stats.json',
      contentText: statsJson,
      message: `Update artwork stats (${stats.totalArtworksRegistered})`,
    });
    lastPublishedStatsJson = statsJson;
    return { path: 'stats.json', htmlUrl: result.data.content?.html_url, commitUrl: result.data.commit?.html_url };
  } catch (error) {
    console.error('Could not publish stats.json to GitHub', error);
    return { error: error.message || 'Stats publish failed' };
  } finally {
    statsPublishInFlight = false;
  }
}

async function createOrUpdateGitHubFile({ filePath, contentText, message }) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  let sha;
  try {
    const existing = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: filePath,
      ref: GITHUB_BRANCH,
    });
    if (!Array.isArray(existing.data)) sha = existing.data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  return octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: filePath,
    message,
    content: Buffer.from(contentText).toString('base64'),
    branch: GITHUB_BRANCH,
    sha,
  });
}

async function saveRegistrationToGitHub(id, registration, action = 'Add') {
  const filePath = `registrations/${id}.json`;
  const result = await createOrUpdateGitHubFile({
    filePath,
    contentText: `${JSON.stringify(registration, null, 2)}
`,
    message: `${action} artwork registration ${id}`,
  });
  return { path: filePath, htmlUrl: result.data.content?.html_url, commitUrl: result.data.commit?.html_url };
}

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Bad request' });
});

if (GITHUB_TOKEN && STATS_PUBLISH_INTERVAL_SECONDS > 0) {
  const intervalMs = Math.max(60, STATS_PUBLISH_INTERVAL_SECONDS) * 1000;
  setInterval(() => {
    publishStatsToGitHub('periodic').catch((error) => console.error(error));
  }, intervalMs);
  publishStatsToGitHub('startup').catch((error) => console.error(error));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fine Arts Exhibition API listening on 0.0.0.0:${PORT}`);
});
