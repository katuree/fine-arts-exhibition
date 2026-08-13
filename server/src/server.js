// server.js – Fine Arts Exhibition API v3 (multi-artwork)
// Handles multiple artworks per artist registration.
// Each artwork gets its own artwork-info.json inside the registration folder.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Storage } from 'megajs';
import * as fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment ──
const PORT = parseInt(String(process.env.PORT || '8080'), 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://192.168.1.45:8088';
const MAX_FILE_MB = parseInt(String(process.env.MAX_FILE_MB || '10'), 10);
const MAX_ARTWORKS_PER_REGISTRATION = parseInt(
  String(process.env.MAX_ARTWORKS_PER_REGISTRATION || '10'),
  10,
);
const MAX_ARTWORK_FILES = parseInt(
  String(process.env.MAX_ARTWORK_FILES || '10'),
  10,
);
const MAX_PROFILE_FILES = parseInt(
  String(process.env.MAX_PROFILE_FILES || '1'),
  10,
);

// ── Local storage dirs ──
const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '..', 'data', 'uploads');
const TEMP_DIR = process.env.TEMP_DIR || os.tmpdir();
const BATCH_FOLDERS = [
  '2020 Batch', '2021 Batch', '2022 Batch', '2023 Batch', '2024 Batch', '2025 Batch',
];

// ── MEGA env ──
const MEGA_EMAIL = String(process.env.MEGA_EMAIL || '').trim();
const MEGA_PASSWORD = String(process.env.MEGA_PASSWORD || '');
const MEGA_ROOT_FOLDER = String(process.env.MEGA_ROOT_FOLDER || 'Fine Arts Exhibition').trim();
const USE_MEGA = Boolean(MEGA_EMAIL && MEGA_PASSWORD);

// ── Ensure local storage folders exist (non-blocking — if it fails, it will fail on first request)
(async () => {
  try {
    await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, 'Artists'), { recursive: true });
    for (const rootName of ['Registered', 'Approved']) {
      for (const batch of BATCH_FOLDERS) {
        await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, rootName, batch), { recursive: true });
      }
    }
  } catch (err) {
    console.error('Failed to create storage dirs:', err.message);
  }
})();

// ── Express app ──
const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ── Local file storage (multer) ──
const multerStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, TEMP_DIR);
  },
  filename(req, file, cb) {
    const safeName = String(file.originalname || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `finearts-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`);
  },
});

// ── multer middleware: max 10 artwork files + 1 profile, each ≤ MAX_FILE_MB ──
const registrationUpload = multer({
  storage: multerStorage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: MAX_ARTWORK_FILES + MAX_PROFILE_FILES,
  },
  fileFilter(_req, file, cb) {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp',
      'application/pdf',
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
}).fields([
  { name: 'profilePicture', maxCount: MAX_PROFILE_FILES },
  { name: 'artworkFiles[]', maxCount: MAX_ARTWORK_FILES },
]);

// ── Static files for frontend (if served from /docs) ──
const ROOT_DIR = path.resolve(__dirname, '..', '..');
app.use(express.static(ROOT_DIR));

// ── MEGA storage helpers ──
let mega = null;
let megaRoots = null;

async function connectMega() {
  if (!USE_MEGA) return null;
  if (mega && megaRoots) return mega;

  mega = await new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  });

  // Wait for root to be ready (megajs v1.x loads root asynchronously)
  if (typeof mega.loadRoot === 'function') {
    await mega.loadRoot();
  }
  if (!mega.root) {
    mega.root = mega; // Fallback: use the storage instance itself
  }

  // mega.root might be the Storage instance itself, which has 'children' as a getter
  let exhibitionRoot = mega.root;
  // If mega.root is a Storage instance, use it directly — ensureMegaFolder handles it
  const artistsRoot = await ensureMegaFolder(exhibitionRoot, 'Artists');
  const registeredRoot = await ensureMegaFolder(exhibitionRoot, 'Registered');
  const approvedRoot = await ensureMegaFolder(exhibitionRoot, 'Approved');

  for (const batch of BATCH_FOLDERS) {
    await ensureMegaFolder(registeredRoot, batch);
    await ensureMegaFolder(approvedRoot, batch);
  }

  megaRoots = { exhibitionRoot, artistsRoot, registeredRoot, approvedRoot };
  console.log('Connected to MEGA successfully');
  return mega;
}

async function ensureMegaFolder(parent, name) {
  if (!parent) return null;
  const children = (parent.children || []).filter(c => c.name === name && c.directory);
  if (children.length) return children[0];
  if (typeof parent.createFolder !== 'function') return null;
  const newFolder = await parent.createFolder(name);
  return newFolder;
}

async function findChild(root, childName, exactMatch) {
  if (!root) return null;
  const children = (root.children || []).filter(c => c.directory);
  if (exactMatch) return children.find(c => c.name === childName) || null;
  return children.find(c => c.name.toLowerCase().includes(childName.toLowerCase())) || null;
}

async function readMegaJsonFile(folder, filename) {
  if (!folder) return null;
  const file = folder.children?.find?.(c => c.name === filename);
  if (!file || !file.download) return null;
  const stream = file.download();
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

async function writeMegaJsonFile(folder, filename, data) {
  if (!folder) return null;
  const existing = folder.children?.find?.(c => c.name === filename);
  if (existing) {
    await existing.delete(true);
  }
  const file = await folder.createFile(filename);
  await file.write(JSON.stringify(data, null, 2));
  return file;
}

async function uploadTempFileToMega(folder, file, targetName) {
  if (!folder) return null;
  const existing = folder.children?.find?.(c => c.name === targetName);
  if (existing) {
    await existing.delete(true);
  }
  const uploaded = await folder.createFile(targetName);
  const stream = uploaded.write();
  const source = fs.createReadStream(file.path);
  await new Promise((resolve, reject) => {
    source.pipe(stream).on('finish', resolve).on('error', reject);
  });
  await uploaded.close();
  return uploaded;
}

function getMegaNodeId(file) {
  const match = Object.entries(mega?.files || {}).find(([, candidate]) => candidate === file);
  return match ? match[0] : null;
}

function megaFileMetadata(file, originalName, mimeType) {
  const nodeId = getMegaNodeId(file);
  return {
    nodeId: nodeId || file.name,
    originalName,
    storedName: file.name,
    mimeType,
    size: file.size || 0,
    megaSyncPath: file.name,
    url: `${PUBLIC_BASE_URL}/api/media/mega/${encodeURIComponent(file.name)}`,
  };
}

async function deleteMegaArtworkFiles(folder, files) {
  if (!folder || !files) return;
  for (const file of files) {
    const megaFile = mega?.files?.[file.nodeId];
    if (megaFile) {
      await megaFile.delete(true);
    }
  }
}

async function replaceMegaArtistProfilePicture(artistFolder, artistInfo, file) {
  const profileFolder = await ensureMegaFolder(artistFolder, 'profile');
  const extension = path.extname(file.originalname) || '.jpg';
  const uploaded = await uploadTempFileToMega(profileFolder, file, `profile-picture${extension}`);
  return {
    ...artistInfo,
    profilePicture: megaFileMetadata(uploaded, file.originalname, file.mimetype),
  };
}

async function findOrCreateMegaArtist({ fullName, batch }) {
  const folders = (megaRoots.artistsRoot.children || []).filter((c) => c.directory);
  const existing = folders.find((f) => {
    try {
      const info = JSON.parse(f.name);
      return info.fullName?.toLowerCase() === fullName.toLowerCase();
    } catch {
      return false;
    }
  });
  if (existing) {
    const info = await readMegaJsonFile(existing, 'artist-info.json');
    return { folder: existing, info };
  }
  const artistId = `ARTIST-${batch.replace(/\s/g, '-')}-${crypto.randomBytes(4).toString('hex').slice(0, 8).toUpperCase()}`;
  const folder = await ensureMegaFolder(megaRoots.artistsRoot, artistId);
  await ensureMegaFolder(folder, 'profile');
  const info = {
    artistId,
    fullName: fullName.trim(),
    batch,
    updatedAt: new Date().toISOString(),
    profilePicture: null,
  };
  await writeMegaJsonFile(folder, 'artist-info.json', info);
  return { folder, info };
}

// ── Local storage helpers ──
async function replaceLocalArtistProfilePicture(artistDir, artistInfo, file) {
  const profileDir = path.join(artistDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });
  const extension = path.extname(file.originalname) || '.jpg';
  const destPath = path.join(profileDir, `profile-picture${extension}`);
  await fsp.copyFile(file.path, destPath);
  const rel = path.relative(LOCAL_STORAGE_DIR, destPath).replace(/\\/g, '/');
  return {
    ...artistInfo,
    profilePicture: {
      nodeId: rel,
      originalName: file.originalname,
      storedName: `profile-picture${extension}`,
      mimeType: file.mimetype,
      size: file.size,
      url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}`,
    },
  };
}

async function ensureLocalFolder(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// ── Helpers ──
function normalizeBatch(year) {
  return String(year || '').replace(/(\d{4})\s*(Batch|batch)/, '$1 Batch').trim();
}

function buildArtworkFilename(originalName, index) {
  const safeName = String(originalName || 'artwork')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return `artwork-${String(index).padStart(2, '0')}-${safeName}`;
}

async function flattenIncomingFiles(files) {
  const result = {};
  for (const [key, value] of Object.entries(files || {})) {
    result[key] = Array.isArray(value) ? value : [value];
  }
  return result;
}

function createRegistrationId() {
  return `REG-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
}

function validateArtistFields(body) {
  if (!body.fullName || !body.fullName.trim()) {
    throw new Error('Artist name is required.');
  }
  if (!body.studentYear) {
    throw new Error('Student batch is required.');
  }
}

function hydrateRegistration(registration, artistInfo) {
  return {
    ...registration,
    student: {
      fullName: registration.student?.fullName || artistInfo?.fullName || registration.artistId,
      studentYear: registration.student?.studentYear || artistInfo?.batch || '',
      profilePicture: registration.student?.profilePicture || artistInfo?.profilePicture || null,
    },
    artwork: {
      title: registration.artwork?.title || '',
      category: registration.artwork?.category || '',
      medium: registration.artwork?.medium || '',
      dimensions: registration.artwork?.dimensions || '',
      description: registration.artwork?.description || '',
    },
    files: registration.files || [],
    source: USE_MEGA ? 'MEGA' : 'Local Disk',
  };
}

async function listMegaRegistrationsFromRoot(root, defaultStatus) {
  if (!root || !USE_MEGA) return [];
  const batchFolders = (root.children || []).filter(c => c.directory);
  const results = [];
  for (const batchFolder of batchFolders) {
    const artistFolders = (batchFolder.children || []).filter(c => c.directory);
    for (const artistFolder of artistFolders) {
      const registrationFolders = (artistFolder.children || []).filter(c => c.directory);
      for (const regFolder of registrationFolders) {
        const info = await readMegaJsonFile(regFolder, 'artwork-info.json');
        if (info) {
          results.push({
            ...info,
            status: defaultStatus,
            files: info.files || [],
            artistFolder,
            regFolder,
          });
        }
      }
    }
  }
  return results;
}

function findChildByName(root, name) {
  if (!root) return null;
  return (root.children || []).find(c => c.name === name && c.directory);
}

async function getArtistInfo(artistId) {
  if (USE_MEGA && megaRoots) {
    const folder = findChild(megaRoots.artistsRoot, artistId, true);
    if (!folder) return null;
    return await readMegaJsonFile(folder, 'artist-info.json');
  }
  const artistDir = path.join(LOCAL_STORAGE_DIR, 'Artists', artistId);
  try {
    const content = await fsp.readFile(path.join(artistDir, 'artist-info.json'), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Health endpoint ──
app.get('/api/health', async (req, res) => {
  try {
    let megaHealth = null;
    let localHealth = null;

    if (USE_MEGA) {
      try {
        await connectMega();
        if (megaRoots && megaRoots.exhibitionRoot) {
          const regRoot = megaRoots.registeredRoot || {};
          const appRoot = megaRoots.approvedRoot || {};
          megaHealth = {
            status: 'connected',
            folder: MEGA_ROOT_FOLDER,
            registeredCount: (regRoot.children || []).length,
            approvedCount: (appRoot.children || []).length,
          };
        }
      } catch (err) {
        megaHealth = { status: 'error', message: err.message };
      }
    }

    try {
      const registeredFolders = await fsp.readdir(path.join(LOCAL_STORAGE_DIR, 'Registered'));
      localHealth = {
        status: 'ready',
        registeredFolders,
      };
    } catch (err) {
      localHealth = { status: 'error', message: err.message };
    }

    const batches = BATCH_FOLDERS;

    res.json({
      ok: true,
      service: 'fine-arts-exhibition-api',
      version: '3.0.0',
      storageMode: USE_MEGA ? 'MEGA' : 'Local Disk',
      megaStorage: megaHealth,
      localDisk: localHealth,
      permanentStorage: USE_MEGA ? 'MEGA' : 'Local Disk',
      storagePath: USE_MEGA ? MEGA_ROOT_FOLDER : LOCAL_STORAGE_DIR,
      batches,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'Health check failed',
      message: err.message,
    });
  }
});

// ── Artwork storage (GET) ──
app.get('/api/storage/:path*', async (req, res) => {
  try {
    const filePath = path.join(LOCAL_STORAGE_DIR, ...req.params.path.split('/'));
    if (!filePath.startsWith(LOCAL_STORAGE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    res.status(500).json({ error: 'Storage error' });
  }
});

// ── Get all registrations ──
app.get('/api/registrations', async (req, res) => {
  try {
    const batchFilter = req.query.batch;
    const statusFilter = req.query.status;
    const artistFilter = req.query.artist;

    let pending = [];
    let approved = [];

    if (USE_MEGA) {
      await connectMega();
      pending = await listMegaRegistrationsFromRoot(megaRoots.registeredRoot, 'Pending');
      approved = await listMegaRegistrationsFromRoot(megaRoots.approvedRoot, 'Approved');
    } else {
      const listLocalRegistrations = async (basePath) => {
        const results = [];
        try {
          const batchFolders = await fsp.readdir(basePath);
          for (const batch of batchFolders) {
            const artistPath = path.join(basePath, batch);
            const artists = await fsp.readdir(artistPath);
            for (const artist of artists) {
              const regPath = path.join(artistPath, artist);
              try {
                const files = await fsp.readdir(regPath);
                if (files.includes('artwork-info.json')) {
                  const info = JSON.parse(await fsp.readFile(path.join(regPath, 'artwork-info.json'), 'utf8'));
                  const rel = path.relative(LOCAL_STORAGE_DIR, regPath).replace(/\\/g, '/');
                  results.push({
                    ...info,
                    source: 'Local Disk',
                    files: (info.files || []).map(f => ({
                      ...f,
                      url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}/${encodeURIComponent(f.storedName || '')}`,
                    })),
                    student: {
                      fullName: info.artistName || '',
                      studentYear: info.batch || '',
                      profilePicture: null,
                    },
                    artwork: {
                      title: info.artwork?.title || info.title || '',
                      category: info.artwork?.category || info.category || '',
                      medium: info.artwork?.medium || info.medium || '',
                      dimensions: info.artwork?.dimensions || info.dimensions || '',
                      description: info.artwork?.description || info.description || '',
                    },
                  });
                }
              } catch {}
            }
          }
        } catch {}
        return results;
      };
      pending = await listLocalRegistrations(path.join(LOCAL_STORAGE_DIR, 'Registered'));
      approved = await listLocalRegistrations(path.join(LOCAL_STORAGE_DIR, 'Approved'));
    }

    let all = [...pending, ...approved];

    if (batchFilter) {
      all = all.filter(r => String(r.batch || '').toLowerCase() === batchFilter.toLowerCase());
    }
    if (statusFilter) {
      all = all.filter(r => String(r.status || '').toLowerCase() === statusFilter.toLowerCase());
    }
    if (artistFilter) {
      all = all.filter(r => String(r.artistName || r.student?.fullName || '').toLowerCase().includes(artistFilter.toLowerCase()));
    }

    res.json({
      ok: true,
      registrations: all,
      total: all.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Create registration (POST) — supports multiple artworks ──
app.post('/api/registrations', registrationUpload, async (req, res) => {
  const incomingFiles = flattenIncomingFiles(req.files);
  try {
    validateArtistFields(req.body);

    // With .fields(): req.files is { profilePicture: [...], artworkFiles: [...] }
    const artworkUploads = Array.isArray(req.files?.artworkFiles) ? req.files.artworkFiles : [];
    const profileUploads = Array.isArray(req.files?.profilePicture) ? req.files.profilePicture : [];

    if (!artworkUploads.length) {
      return res.status(400).json({ error: 'Please upload at least one artwork file.' });
    }

    const batch = normalizeBatch(req.body.studentYear);
    if (!BATCH_FOLDERS.includes(batch)) {
      return res.status(400).json({ error: 'Select a batch from 2020 Batch to 2025 Batch.' });
    }

    const fullName = String(req.body.fullName || '').trim();
    const category = req.body.category === 'Other'
      ? String(req.body.otherCategory || '').trim()
      : String(req.body.category || '').trim();

    if (!category) {
      return res.status(400).json({ error: 'Artwork category is required.' });
    }

    const medium = String(req.body.medium || '').trim();
    const dimensions = String(req.body.dimensions || '').trim();
    const description = String(req.body.description || '').trim();

    // Support single or multiple artworks
    const artworkTitles = Array.isArray(req.body.artworkTitle)
      ? req.body.artworkTitle
      : [req.body.artworkTitle || 'Untitled'];
    const artworkCategories = Array.isArray(req.body.category)
      ? req.body.category
      : [req.body.category || ''];
    const otherCategories = Array.isArray(req.body.otherCategory)
      ? req.body.otherCategory
      : [req.body.otherCategory || ''];
    const mediums = Array.isArray(req.body.medium)
      ? req.body.medium
      : [req.body.medium || ''];
    const dimensionsArr = Array.isArray(req.body.dimensions)
      ? req.body.dimensions
      : [req.body.dimensions || ''];
    const descriptions = Array.isArray(req.body.description)
      ? req.body.description
      : [req.body.description || ''];

    const artworks = artworkTitles.map((title, i) => ({
      title: String(title || 'Untitled').trim(),
      category: artworkCategories[i] === 'Other'
        ? (otherCategories[i] || '').trim() || category
        : (artworkCategories[i] || category || '').trim(),
      medium: (mediums[i] || medium || '').trim(),
      dimensions: (dimensionsArr[i] || dimensions || '').trim(),
      description: (descriptions[i] || description || '').trim(),
    }));

    // Filter out empty artwork titles
    const validArtworks = artworks.filter(a => a.title);
    if (validArtworks.length === 0) {
      return res.status(400).json({ error: 'At least one artwork must have a title.' });
    }

    // Limit artworks per registration
    if (validArtworks.length > MAX_ARTWORKS_PER_REGISTRATION) {
      return res.status(400).json({ error: `Maximum ${MAX_ARTWORKS_PER_REGISTRATION} artworks allowed per registration.` });
    }

    // Distribute artwork files among artworks
    const filesPerArtwork = Math.ceil(artworkUploads.length / validArtworks.length);
    const artworkFileGroups = [];
    for (let i = 0; i < validArtworks.length; i++) {
      artworkFileGroups.push(artworkUploads.slice(i * filesPerArtwork, (i + 1) * filesPerArtwork));
    }
    // Ensure last artwork gets remaining files
    if (artworkFileGroups.length < validArtworks.length) {
      while (artworkFileGroups.length < validArtworks.length) {
        artworkFileGroups.push([]);
      }
    }

    const now = new Date().toISOString();

    if (USE_MEGA) {
      await connectMega();
      const artist = await findOrCreateMegaArtist({ fullName, batch });
      let artistInfo = artist.info;

      if (profileUploads.length) {
        artistInfo = await replaceMegaArtistProfilePicture(artist.folder, artistInfo, profileUploads[0]);
      }

      artistInfo = {
        ...artistInfo,
        fullName,
        batch,
        updatedAt: now,
      };
      await writeMegaJsonFile(artist.folder, 'artist-info.json', artistInfo);

      const batchFolder = await ensureMegaFolder(megaRoots.registeredRoot, batch);
      const artistArtworkRoot = await ensureMegaFolder(batchFolder, artistInfo.artistId);

      const results = [];

      for (let a = 0; a < validArtworks.length; a++) {
        const artwork = validArtworks[a];
        const filesForThisArtwork = artworkFileGroups[a] || [];
        const registrationId = await createRegistrationId();
        const registrationFolder = await ensureMegaFolder(artistArtworkRoot, registrationId);

        const storedArtworkFiles = [];
        for (let index = 0; index < filesForThisArtwork.length; index += 1) {
          const file = filesForThisArtwork[index];
          const storedName = buildArtworkFilename(file.originalname, index + 1);
          const uploaded = await uploadTempFileToMega(registrationFolder, file, storedName);
          storedArtworkFiles.push(megaFileMetadata(uploaded, file.originalname, file.mimetype));
        }

        const registration = {
          id: registrationId,
          artistId: artistInfo.artistId,
          status: 'Pending',
          createdAt: now,
          artwork: artwork,
          files: storedArtworkFiles,
          artistName: fullName,
          batch,
        };

        await writeMegaJsonFile(registrationFolder, 'artwork-info.json', registration);
        results.push(hydrateRegistration(registration, artistInfo));
      }

      res.status(201).json({
        ok: true,
        registrations: results,
      });
    } else {
      // Local mode
      const artistDir = path.join(LOCAL_STORAGE_DIR, 'Artists', `ARTIST-${batch.replace(/\s/g, '-')}-${crypto.randomBytes(4).toString('hex').slice(0, 8).toUpperCase()}`);
      await fsp.mkdir(artistDir, { recursive: true });
      const artistInfo = {
        artistId: path.basename(artistDir),
        fullName,
        batch,
        updatedAt: now,
        profilePicture: null,
      };
      await fsp.writeFile(path.join(artistDir, 'artist-info.json'), JSON.stringify(artistInfo, null, 2), 'utf8');

      const regDir = path.join(LOCAL_STORAGE_DIR, 'Registered', batch, artistInfo.artistId);
      const results = [];

      for (let a = 0; a < validArtworks.length; a++) {
        const artwork = validArtworks[a];
        const filesForThisArtwork = artworkFileGroups[a] || [];
        const registrationId = await createRegistrationId();
        const registrationFolder = path.join(regDir, registrationId);
        await fsp.mkdir(registrationFolder, { recursive: true });

        const storedArtworkFiles = [];
        for (let index = 0; index < filesForThisArtwork.length; index += 1) {
          const file = filesForThisArtwork[index];
          const storedName = buildArtworkFilename(file.originalname, index + 1);
          const destPath = path.join(registrationFolder, storedName);
          await fsp.copyFile(file.path, destPath);
          const rel = path.relative(LOCAL_STORAGE_DIR, destPath).replace(/\\/g, '/');
          storedArtworkFiles.push({
            nodeId: rel,
            originalName: file.originalname,
            storedName,
            mimeType: file.mimetype,
            size: file.size,
            url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}`,
          });
        }

        const registration = {
          id: registrationId,
          artistId: artistInfo.artistId,
          status: 'Pending',
          createdAt: now,
          artwork,
          files: storedArtworkFiles,
          artistName: fullName,
          batch,
        };

        await fsp.writeFile(path.join(registrationFolder, 'artwork-info.json'), JSON.stringify(registration, null, 2), 'utf8');
        results.push(hydrateRegistration(registration, artistInfo));
      }

      res.status(201).json({
        ok: true,
        registrations: results,
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Get registration by ID ──
app.get('/api/registrations/:id', async (req, res) => {
  try {
    const found = await findRegistration(req.params.id);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Registration not found.' });
    }
    let artistInfo = await getArtistInfo(found.registration.artistId);
    res.json({ ok: true, registration: hydrateRegistration(found.registration, artistInfo) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Update registration (PUT) ──
app.put('/api/registrations/:id', registrationUpload, async (req, res) => {
  const incomingFiles = flattenIncomingFiles(req.files);
  try {
    const found = await findRegistration(req.params.id);
    if (!found) {
      return res.status(404).json({ error: 'Registration not found.' });
    }

    const existing = found.registration;
    let artistInfo = await getArtistInfo(existing.artistId);
    if (!artistInfo) throw new Error('Artist profile not found.');

    const profileUploads = req.files?.profilePicture || [];
    const artworkUploads = [...(req.files?.artworkFiles || []), ...(req.files?.['artworkFiles[]'] || [])];
    const now = new Date().toISOString();

    if (req.body.fullName !== undefined) {
      const fullName = String(req.body.fullName || '').trim();
      if (!fullName) return res.status(400).json({ error: 'Artist name cannot be empty.' });
      artistInfo.fullName = fullName;
    }

    if (req.body.studentYear !== undefined) {
      const batch = normalizeBatch(req.body.studentYear);
      if (!BATCH_FOLDERS.includes(batch)) {
        return res.status(400).json({ error: 'Select a batch from 2020 Batch to 2025 Batch.' });
      }
      artistInfo.batch = batch;
    }

    artistInfo.updatedAt = now;

    // Support multi-artwork updates
    const artworkTitle = req.body.artworkTitle;
    if (Array.isArray(artworkTitle) && artworkTitle.length > 0) {
      artistInfo._multiArtwork = artworkTitle.map((t, i) => ({
        title: String(t || 'Untitled').trim(),
        category: Array.isArray(req.body.category) ? req.body.category[i] : (req.body.category || ''),
        medium: Array.isArray(req.body.medium) ? req.body.medium[i] : (req.body.medium || ''),
        dimensions: Array.isArray(req.body.dimensions) ? req.body.dimensions[i] : (req.body.dimensions || ''),
        description: Array.isArray(req.body.description) ? req.body.description[i] : (req.body.description || ''),
      }));
    }

    if (USE_MEGA) {
      const artistFolder = findChild(megaRoots.artistsRoot, existing.artistId, true);
      if (profileUploads.length) {
        artistInfo = await replaceMegaArtistProfilePicture(artistFolder, artistInfo, profileUploads[0]);
      }
      await writeMegaJsonFile(artistFolder, 'artist-info.json', artistInfo);

      let files = Array.isArray(existing.files) ? existing.files : [];
      if (artworkUploads.length) {
        await deleteMegaArtworkFiles(found.folder, files);
        files = [];
        for (let index = 0; index < artworkUploads.length; index += 1) {
          const file = artworkUploads[index];
          const uploaded = await uploadTempFileToMega(found.folder, file, buildArtworkFilename(file.originalname, index + 1));
          files.push(megaFileMetadata(uploaded, file.originalname, file.mimetype));
        }
      }

      const updated = {
        ...existing,
        updatedAt: now,
        student: {
          fullName: artistInfo.fullName,
          studentYear: artistInfo.batch,
          profilePicture: artistInfo.profilePicture || null,
        },
        artwork: {
          title: req.body.artworkTitle !== undefined ? String(req.body.artworkTitle).trim() : existing.artwork?.title,
          category: req.body.category !== undefined ? String(req.body.category).trim() : existing.artwork?.category,
          medium: req.body.medium !== undefined ? String(req.body.medium).trim() : existing.artwork?.medium,
          dimensions: req.body.dimensions !== undefined ? String(req.body.dimensions).trim() : existing.artwork?.dimensions,
          description: req.body.description !== undefined ? String(req.body.description).trim() : existing.artwork?.description,
        },
        files,
      };

      await writeMegaJsonFile(found.folder, 'artwork-info.json', updated);

      res.json({
        ok: true,
        id: updated.id,
        registration: hydrateRegistration(updated, artistInfo),
      });
    } else {
      const artistDir = path.join(LOCAL_STORAGE_DIR, 'Artists', existing.artistId);
      if (profileUploads.length) {
        artistInfo = await replaceLocalArtistProfilePicture(artistDir, artistInfo, profileUploads[0]);
      }
      await fsp.writeFile(path.join(artistDir, 'artist-info.json'), JSON.stringify(artistInfo, null, 2), 'utf8');

      let files = Array.isArray(existing.files) ? existing.files : [];
      if (artworkUploads.length) {
        const regDir = found.dir;
        for (const file of files) {
          try {
            await fsp.unlink(path.join(LOCAL_STORAGE_DIR, file.nodeId));
          } catch {}
        }
        files = [];
        for (let index = 0; index < artworkUploads.length; index += 1) {
          const file = artworkUploads[index];
          const storedName = buildArtworkFilename(file.originalname, index + 1);
          const destPath = path.join(regDir, storedName);
          await fsp.copyFile(file.path, destPath);
          const rel = path.relative(LOCAL_STORAGE_DIR, destPath).replace(/\\/g, '/');
          files.push({
            nodeId: rel,
            originalName: file.originalname,
            storedName,
            mimeType: file.mimetype,
            size: file.size,
            url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}`,
          });
        }
      }

      const updated = {
        ...existing,
        updatedAt: now,
        student: {
          fullName: artistInfo.fullName,
          studentYear: artistInfo.batch,
          profilePicture: artistInfo.profilePicture || null,
        },
        artwork: {
          title: req.body.artworkTitle !== undefined ? String(req.body.artworkTitle).trim() : existing.artwork?.title,
          category: req.body.category !== undefined ? String(req.body.category).trim() : existing.artwork?.category,
          medium: req.body.medium !== undefined ? String(req.body.medium).trim() : existing.artwork?.medium,
          dimensions: req.body.dimensions !== undefined ? String(req.body.dimensions).trim() : existing.artwork?.dimensions,
          description: req.body.description !== undefined ? String(req.body.description).trim() : existing.artwork?.description,
        },
        files,
      };

      await fsp.writeFile(path.join(found.dir, 'artwork-info.json'), JSON.stringify(updated, null, 2), 'utf8');

      res.json({
        ok: true,
        id: updated.id,
        registration: hydrateRegistration(updated, artistInfo),
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Review registration (PATCH) ──
app.patch('/api/registrations/:id/review', async (req, res) => {
  try {
    const found = await findRegistration(req.params.id);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Registration not found.' });
    }

    const registration = found.registration;
    const requestedStatus = String(req.body.status || '').trim();

    if (!['Approved', 'Pending'].includes(requestedStatus)) {
      return res.status(400).json({ ok: false, error: 'Status must be Approved or Pending.' });
    }

    const now = new Date().toISOString();
    const batch = String(registration.batch || '').trim();

    if (USE_MEGA) {
      await connectMega();
      const desiredRoot = requestedStatus === 'Approved' ? megaRoots.approvedRoot : megaRoots.registeredRoot;
      const batchFolder = await ensureMegaFolder(desiredRoot, batch);
      const artistFolder = await ensureMegaFolder(batchFolder, registration.artistId);

      const registrationFiles = (registration.files || []).map(f => ({
        ...f,
        provider: 'MEGA',
      }));

      const updated = {
        ...registration,
        status: requestedStatus,
        reviewedBy: req.body.reviewedBy || 'admin',
        reviewedAt: now,
        updatedAt: now,
        files: registrationFiles,
      };

      await writeMegaJsonFile(found.folder, 'artwork-info.json', updated);

      res.json({
        ok: true,
        id: updated.id,
        registration: hydrateRegistration(updated, null),
      });
    } else {
      const regDir = found.dir;
      const desiredDir = path.join(LOCAL_STORAGE_DIR, requestedStatus, batch, registration.artistId, registration.id);
      await fsp.mkdir(desiredDir, { recursive: true });

      const registrationFiles = (registration.files || []).map(f => ({
        ...f,
        nodeId: path.relative(LOCAL_STORAGE_DIR, path.join(desiredDir, f.storedName))
          .replace(/\\/g, '/'),
        provider: 'Local Disk',
        url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(path.relative(LOCAL_STORAGE_DIR, path.join(desiredDir, f.storedName)).replace(/\\/g, '/'))}`,
      }));

      const updated = {
        ...registration,
        status: requestedStatus,
        reviewedBy: req.body.reviewedBy || 'admin',
        reviewedAt: now,
        updatedAt: now,
        files: registrationFiles,
      };

      // Move files to new location
      for (const file of registration.files || []) {
        const src = path.join(LOCAL_STORAGE_DIR, file.nodeId);
        const dst = path.join(desiredDir, file.storedName);
        try {
          await fsp.copyFile(src, dst);
        } catch {
          // File may not exist
        }
      }

      await fsp.writeFile(path.join(regDir, 'artwork-info.json'), JSON.stringify(updated, null, 2), 'utf8');

      res.json({
        ok: true,
        id: updated.id,
        registration: hydrateRegistration(updated, null),
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Get artist info ──
app.get('/api/artists/:artistId', async (req, res) => {
  try {
    const artistInfo = await getArtistInfo(req.params.artistId);
    if (!artistInfo) {
      return res.status(404).json({ ok: false, error: 'Artist not found.' });
    }
    res.json({ ok: true, artist: artistInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Admin registration info ──
app.get('/api/admin/registrations', async (req, res) => {
  try {
    let pending = [];
    let approved = [];

    if (USE_MEGA) {
      await connectMega();
      pending = await listMegaRegistrationsFromRoot(megaRoots.registeredRoot, 'Pending');
      approved = await listMegaRegistrationsFromRoot(megaRoots.approvedRoot, 'Approved');
    } else {
      const listLocalRegistrations = async (basePath) => {
        const results = [];
        try {
          const batchFolders = await fsp.readdir(basePath);
          for (const batch of batchFolders) {
            const artistPath = path.join(basePath, batch);
            const artists = await fsp.readdir(artistPath);
            for (const artist of artists) {
              const regPath = path.join(artistPath, artist);
              try {
                const files = await fsp.readdir(regPath);
                if (files.includes('artwork-info.json')) {
                  const info = JSON.parse(await fsp.readFile(path.join(regPath, 'artwork-info.json'), 'utf8'));
                  const rel = path.relative(LOCAL_STORAGE_DIR, regPath).replace(/\\/g, '/');
                  results.push({
                    ...info,
                    source: 'Local Disk',
                    files: (info.files || []).map(f => ({
                      ...f,
                      url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}/${encodeURIComponent(f.storedName || '')}`,
                    })),
                  });
                }
              } catch {}
            }
          }
        } catch {}
        return results;
      };
      pending = await listLocalRegistrations(path.join(LOCAL_STORAGE_DIR, 'Registered'));
      approved = await listLocalRegistrations(path.join(LOCAL_STORAGE_DIR, 'Approved'));
    }

    res.json({
      ok: true,
      pending,
      approved,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Find registration (shared) ──
async function findRegistration(id) {
  if (USE_MEGA) {
    await connectMega();
    for (const rootName of ['Registered', 'Approved']) {
      const root = megaRoots[rootName.toLowerCase() + 'Root'];
      if (!root) continue;
      const batches = (root.children || []).filter(c => c.directory);
      for (const batch of batches) {
        const artists = (batch.children || []).filter(c => c.directory);
        for (const artist of artists) {
          const registrations = (artist.children || []).filter(c => c.directory);
          for (const reg of registrations) {
            try {
              const info = await readMegaJsonFile(reg, 'artwork-info.json');
              if (info && info.id === id) {
                return { registration: info, folder: reg };
              }
            } catch {}
          }
        }
      }
    }
    return null;
  }
  for (const rootName of ['Registered', 'Approved']) {
    const basePath = path.join(LOCAL_STORAGE_DIR, rootName);
    try {
      const batches = await fsp.readdir(basePath);
      for (const batch of batches) {
        const artistPath = path.join(basePath, batch);
        const artists = await fsp.readdir(artistPath);
        for (const artist of artists) {
          const regPath = path.join(artistPath, artist, id);
          try {
            const infoPath = path.join(regPath, 'artwork-info.json');
            const stat = await fsp.stat(infoPath);
            if (stat.isFile()) {
              const info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
              if (info.id === id) {
                return { registration: info, dir: regPath };
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  return null;
}

// ── Startup ──
(async () => {
  // Ensure local storage folders exist
  try {
    await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, 'Artists'), { recursive: true });
    for (const rootName of ['Registered', 'Approved']) {
      for (const batch of BATCH_FOLDERS) {
        await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, rootName, batch), { recursive: true });
      }
    }
  } catch (err) {
    console.error('Failed to create local storage dirs:', err.message);
  }

  if (USE_MEGA) {
    connectMega().catch((err) => console.error('MEGA initial connection warning:', err.message));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Fine Arts Exhibition API running on port ${PORT}`);
    console.log(`Storage Mode: ${USE_MEGA ? 'MEGA' : 'Local Disk (' + LOCAL_STORAGE_DIR + ')'}`);
  });
})();
