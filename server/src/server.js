import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { Storage } from 'megajs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const LOCAL_STORAGE_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads'));

const app = express();
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const MEGA_EMAIL = String(process.env.MEGA_EMAIL || '').trim();
const MEGA_PASSWORD = String(process.env.MEGA_PASSWORD || '');
const MEGA_ROOT_FOLDER = String(process.env.MEGA_ROOT_FOLDER || 'Fine Arts Exhibition').trim();
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);

const BATCH_FOLDERS = [
  '2020 Batch',
  '2021 Batch',
  '2022 Batch',
  '2023 Batch',
  '2024 Batch',
  '2025 Batch',
];

const ARTWORK_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const PROFILE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const USE_MEGA = Boolean(MEGA_EMAIL && MEGA_PASSWORD);

const TEMP_DIR = path.join(os.tmpdir(), 'fine-arts-exhibition-incoming');
await fsp.mkdir(TEMP_DIR, { recursive: true });

// Ensure local storage folders exist (non-blocking — if it fails, it will fail on first request)
(async () => {
  try {
    await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, 'Artists'), { recursive: true });
    for (const rootName of ['Registered', 'Approved']) {
      for (const batch of BATCH_FOLDERS) {
        await fsp.mkdir(path.join(LOCAL_STORAGE_DIR, rootName, batch), { recursive: true });
      }
    }
  } catch (err) {
    console.error('Failed to create storage dirs (will retry on first request):', err.message);
  }
})();

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 11 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'profilePicture') {
      if (!PROFILE_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error('Profile picture must be JPG, PNG, or WEBP.'));
      }
      return cb(null, true);
    }
    if (file.fieldname === 'artworkFiles' || file.fieldname === 'artworkFiles[]') {
      if (!ARTWORK_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error('Artwork files must be JPG, PNG, or PDF.'));
      }
      return cb(null, true);
    }
    return cb(new Error(`Unexpected upload field: ${file.fieldname}`));
  },
});

const registrationUpload = upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'artworkFiles', maxCount: 10 },
  { name: 'artworkFiles[]', maxCount: 10 },
]);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use('/storage', express.static(LOCAL_STORAGE_DIR));
app.use(express.static(ROOT_DIR));

// ── MEGA storage connection ──
let mega = null;
let megaRoots = null;

async function connectMega() {
  if (!USE_MEGA) return null;
  if (mega && megaRoots) return mega;

  console.log('Connecting to MEGA...');
  mega = await new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  }).ready;

  // mega.root is the Cloud Drive root folder (MutableFile)
  // mega.root.children is loaded by autoload — use it directly
  let exhibitionRoot = mega.root.children?.find(c => c.name === MEGA_ROOT_FOLDER);
  if (!exhibitionRoot) {
    exhibitionRoot = await mega.root.mkdir(MEGA_ROOT_FOLDER);
  }

  const artistsRoot = await ensureMegaFolder(exhibitionRoot, 'Artists');
  const registeredRoot = await ensureMegaFolder(exhibitionRoot, 'Registered');
  const approvedRoot = await ensureMegaFolder(exhibitionRoot, 'Approved');

  for (const batch of BATCH_FOLDERS) {
    await ensureMegaFolder(registeredRoot, batch);
    await ensureMegaFolder(approvedRoot, batch);
  }

  megaRoots = { exhibitionRoot, artistsRoot, registeredRoot, approvedRoot };
  if (!registeredRoot || !approvedRoot) {
    megaRoots = null;
    console.error('MEGA folder setup failed');
  } else {
    console.log('Connected to MEGA successfully');
  }
  return mega;
}

if (USE_MEGA) {
  connectMega().catch((err) => console.error('MEGA initial connection warning:', err.message));
} else {
  console.log(`ℹ️  Running in Local Storage mode (directory: ${LOCAL_STORAGE_DIR})`);
}

// ── API Routes ──

app.get('/api/health', async (req, res) => {
  try {
    if (USE_MEGA) await connectMega();
    res.json({
      ok: true,
      service: 'fine-arts-exhibition-api',
      permanentStorage: USE_MEGA ? 'MEGA' : 'Local Disk',
      storagePath: USE_MEGA ? MEGA_ROOT_FOLDER : LOCAL_STORAGE_DIR,
      batches: BATCH_FOLDERS,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message || 'Storage connection failed.',
    });
  }
});

app.get('/api/registrations', async (req, res) => {
  try {
    let registrations = [];
    if (USE_MEGA) {
      await connectMega();
      const pending = await listMegaRegistrationsFromRoot(megaRoots?.registeredRoot, 'Pending');
      const approved = await listMegaRegistrationsFromRoot(megaRoots?.approvedRoot, 'Approved');
      registrations = [...pending, ...approved];
    } else {
      const pending = await listLocalRegistrationsFromRoot('Registered', 'Pending');
      const approved = await listLocalRegistrationsFromRoot('Approved', 'Approved');
      registrations = [...pending, ...approved];
    }

    registrations.sort((a, b) => {
      const aDate = a.updatedAt || a.createdAt || '';
      const bDate = b.updatedAt || b.createdAt || '';
      return String(bDate).localeCompare(String(aDate));
    });

    res.json({
      ok: true,
      count: registrations.length,
      registrations,
    });
  } catch (error) {
    console.error('List registrations error:', error);
    res.status(500).json({ error: error.message || 'Could not load registrations.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    let pendingCount = 0;
    let approvedCount = 0;

    if (USE_MEGA && megaRoots && megaRoots.registeredRoot) {
      try {
        const pending = await listMegaRegistrationsFromRoot(megaRoots.registeredRoot, 'Pending');
        const approved = await listMegaRegistrationsFromRoot(megaRoots.approvedRoot, 'Approved');
        pendingCount = pending.length;
        approvedCount = approved.length;
      } catch (err) {
        console.error('Stats MEGA error:', err.message);
      }
    } else {
      const pending = await listLocalRegistrationsFromRoot('Registered', 'Pending');
      const approved = await listLocalRegistrationsFromRoot('Approved', 'Approved');
      pendingCount = pending.length;
      approvedCount = approved.length;
    }

    res.json({
      ok: true,
      totalArtworksRegistered: pendingCount + approvedCount,
      pending: pendingCount,
      approved: approvedCount,
      updatedAt: new Date().toISOString(),
      source: USE_MEGA ? 'MEGA' : 'Local Disk',
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message || 'Could not calculate stats.' });
  }
});

app.get('/api/media/:nodeId', async (req, res) => {
  try {
    if (USE_MEGA) {
      const storage = await connectMega();
      let file = storage.files?.[req.params.nodeId];
      if (!file) {
        await storage.reload();
        file = storage.files?.[req.params.nodeId];
      }
      if (!file || file.directory) {
        return res.status(404).json({ error: 'File not found.' });
      }

      res.setHeader('Content-Type', mimeTypeFromName(file.name));
      res.setHeader('Cache-Control', 'private, max-age=300');
      const stream = file.download();
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: 'Could not download file.' });
        else res.destroy(err);
      });
      stream.pipe(res);
    } else {
      // Local media decoding
      const relPath = decodeURIComponent(req.params.nodeId);
      const filePath = path.join(LOCAL_STORAGE_DIR, relPath);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found.' });
      }
      res.setHeader('Content-Type', mimeTypeFromName(filePath));
      res.setHeader('Cache-Control', 'private, max-age=300');
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load media.' });
  }
});

app.post('/api/registrations', registrationUpload, async (req, res) => {
  const incomingFiles = flattenIncomingFiles(req.files);
  try {
    validateArtistFields(req.body);
    const artworkUploads = [...(req.files?.artworkFiles || []), ...(req.files?.['artworkFiles[]'] || [])];
    const profileUploads = req.files?.profilePicture || [];

    if (!artworkUploads.length) {
      return res.status(400).json({ error: 'Please upload at least one artwork file.' });
    }

    const batch = normalizeBatch(req.body.studentYear);
    if (!BATCH_FOLDERS.includes(batch)) {
      return res.status(400).json({ error: 'Select a batch from 2020 Batch to 2025 Batch.' });
    }

    const category = req.body.category === 'Other'
      ? String(req.body.otherCategory || '').trim()
      : String(req.body.category || '').trim();

    if (!category) {
      return res.status(400).json({ error: 'Artwork category is required.' });
    }

    const registrationId = await createRegistrationId();
    const now = new Date().toISOString();

    if (USE_MEGA) {
      await connectMega();
      const artist = await findOrCreateMegaArtist({ fullName: req.body.fullName, batch });
      let artistInfo = artist.info;

      if (profileUploads.length) {
        artistInfo = await replaceMegaArtistProfilePicture(artist.folder, artistInfo, profileUploads[0]);
      }

      artistInfo = {
        ...artistInfo,
        fullName: String(req.body.fullName || '').trim(),
        batch,
        updatedAt: now,
      };
      await writeMegaJsonFile(artist.folder, 'artist-info.json', artistInfo);

      const batchFolder = await ensureMegaFolder(megaRoots?.registeredRoot, batch);
      const artistArtworkRoot = await ensureMegaFolder(batchFolder, artistInfo.artistId);
      const registrationFolder = await ensureMegaFolder(artistArtworkRoot, registrationId);

      const storedArtworkFiles = [];
      for (let index = 0; index < artworkUploads.length; index += 1) {
        const file = artworkUploads[index];
        const storedName = buildArtworkFilename(file.originalname, index + 1);
        const uploaded = await uploadTempFileToMega(registrationFolder, file, storedName);
        storedArtworkFiles.push(megaFileMetadata(uploaded, file.originalname, file.mimetype));
      }

      const registration = {
        id: registrationId,
        artistId: artistInfo.artistId,
        status: 'Pending',
        createdAt: now,
        updatedAt: now,
        student: {
          fullName: artistInfo.fullName,
          studentYear: artistInfo.batch,
          profilePicture: artistInfo.profilePicture || null,
        },
        artwork: {
          title: String(req.body.artworkTitle || '').trim(),
          category,
          medium: String(req.body.medium || '').trim(),
          dimensions: String(req.body.dimensions || '').trim(),
          description: String(req.body.description || '').trim(),
        },
        files: storedArtworkFiles,
        storage: {
          provider: 'MEGA',
          state: 'Registered',
          batch,
          artistId: artistInfo.artistId,
          registrationId,
        },
      };

      await writeMegaJsonFile(registrationFolder, 'artwork-info.json', registration);

      res.status(201).json({
        ok: true,
        id: registrationId,
        artistId: artistInfo.artistId,
        registration: hydrateRegistration(registration, artistInfo),
      });
    } else {
      // Local Disk Registration
      const artist = await findOrCreateLocalArtist({ fullName: req.body.fullName, batch });
      let artistInfo = artist.info;

      if (profileUploads.length) {
        artistInfo = await replaceLocalArtistProfilePicture(artist.dir, artistInfo, profileUploads[0]);
      }

      artistInfo = {
        ...artistInfo,
        fullName: String(req.body.fullName || '').trim(),
        batch,
        updatedAt: now,
      };
      await fsp.writeFile(path.join(artist.dir, 'artist-info.json'), JSON.stringify(artistInfo, null, 2), 'utf8');

      const registrationDir = path.join(LOCAL_STORAGE_DIR, 'Registered', batch, artistInfo.artistId, registrationId);
      await fsp.mkdir(registrationDir, { recursive: true });

      const storedArtworkFiles = [];
      for (let index = 0; index < artworkUploads.length; index += 1) {
        const file = artworkUploads[index];
        const storedName = buildArtworkFilename(file.originalname, index + 1);
        const destPath = path.join(registrationDir, storedName);
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
        updatedAt: now,
        student: {
          fullName: artistInfo.fullName,
          studentYear: artistInfo.batch,
          profilePicture: artistInfo.profilePicture || null,
        },
        artwork: {
          title: String(req.body.artworkTitle || '').trim(),
          category,
          medium: String(req.body.medium || '').trim(),
          dimensions: String(req.body.dimensions || '').trim(),
          description: String(req.body.description || '').trim(),
        },
        files: storedArtworkFiles,
        storage: {
          provider: 'Local Disk',
          state: 'Registered',
          batch,
          artistId: artistInfo.artistId,
          registrationId,
        },
      };

      await fsp.writeFile(path.join(registrationDir, 'artwork-info.json'), JSON.stringify(registration, null, 2), 'utf8');

      res.status(201).json({
        ok: true,
        id: registrationId,
        artistId: artistInfo.artistId,
        registration: hydrateRegistration(registration, artistInfo),
      });
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed.' });
  } finally {
    await cleanupIncoming(incomingFiles);
  }
});

app.get('/api/registrations/:id', async (req, res) => {
  try {
    const found = await findRegistration(req.params.id);
    if (!found) {
      return res.status(404).json({ error: 'Registration not found.' });
    }

    const artistInfo = await getArtistInfo(found.registration.artistId);
    res.json({
      ok: true,
      id: found.registration.id,
      registration: hydrateRegistration(found.registration, artistInfo),
    });
  } catch (error) {
    console.error('Get registration error:', error);
    res.status(500).json({ error: error.message || 'Could not load registration.' });
  }
});

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
      // Local mode update
      const artistDir = path.join(LOCAL_STORAGE_DIR, 'Artists', existing.artistId);
      if (profileUploads.length) {
        artistInfo = await replaceLocalArtistProfilePicture(artistDir, artistInfo, profileUploads[0]);
      }
      await fsp.writeFile(path.join(artistDir, 'artist-info.json'), JSON.stringify(artistInfo, null, 2), 'utf8');

      await publishAdminDataToGitHub();

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
  } catch (error) {
    console.error('Update registration error:', error);
    res.status(500).json({ error: error.message || 'Could not update registration.' });
  } finally {
    await cleanupIncoming(incomingFiles);
  }
});

app.patch('/api/registrations/:id/review', async (req, res) => {
  try {
    const requestedStatus = normalizeReviewStatus(req.body?.status);
    if (!requestedStatus) {
      return res.status(400).json({ error: 'Status must be Approved, Rejected, or Pending.' });
    }

    const found = await findRegistration(req.params.id);
    if (!found) {
      return res.status(404).json({ error: 'Registration not found.' });
    }

    const now = new Date().toISOString();
    const registration = {
      ...found.registration,
      status: requestedStatus,
      reviewedAt: now,
      updatedAt: now,
    };

    const batch = normalizeBatch(registration.student?.studentYear);

    if (USE_MEGA) {
      const desiredRoot = requestedStatus === 'Approved' ? megaRoots?.approvedRoot : megaRoots?.registeredRoot;
      const batchFolder = await ensureMegaFolder(desiredRoot, batch);
      const artistFolder = await ensureMegaFolder(batchFolder, registration.artistId);

      if (found.folder.parent !== artistFolder) {
        const existingFolder = findChild(artistFolder, registration.id, true);
        if (existingFolder && existingFolder !== found.folder) {
          await existingFolder.delete(true);
        }
        await found.folder.moveTo(artistFolder);
      }

      registration.storage = {
        ...(registration.storage || {}),
        provider: 'MEGA',
        state: requestedStatus === 'Approved' ? 'Approved' : 'Registered',
        batch,
        artistId: registration.artistId,
        registrationId: registration.id,
      };

      await writeMegaJsonFile(found.folder, 'artwork-info.json', registration);
      const artistInfo = await getArtistInfo(registration.artistId);

      res.json({
        ok: true,
        id: registration.id,
        status: requestedStatus,
        registration: hydrateRegistration(registration, artistInfo),
      });
    } else {
      // Local mode review
      const sourceRoot = requestedStatus === 'Approved' ? 'Registered' : 'Approved';
      const targetRoot = requestedStatus === 'Approved' ? 'Approved' : 'Registered';
      const targetDir = path.join(LOCAL_STORAGE_DIR, targetRoot, batch, registration.artistId, registration.id);

      await fsp.mkdir(path.dirname(targetDir), { recursive: true });
      if (found.dir !== targetDir) {
        await fsp.mkdir(targetDir, { recursive: true });
        const entries = await fsp.readdir(found.dir);
        for (const entry of entries) {
          await fsp.copyFile(path.join(found.dir, entry), path.join(targetDir, entry));
        }
        await fsp.rm(found.dir, { recursive: true, force: true });
      }

      registration.storage = {
        ...(registration.storage || {}),
        provider: 'Local Disk',
        state: requestedStatus === 'Approved' ? 'Approved' : 'Registered',
        batch,
        artistId: registration.artistId,
        registrationId: registration.id,
      };

      await fsp.writeFile(path.join(targetDir, 'artwork-info.json'), JSON.stringify(registration, null, 2), 'utf8');

      await publishAdminDataToGitHub();

      const artistInfo = await getArtistInfo(registration.artistId);

      res.json({
        ok: true,
        id: registration.id,
        status: requestedStatus,
        registration: hydrateRegistration(registration, artistInfo),
      });
    }
  } catch (error) {
    console.error('Review error:', error);
    res.status(500).json({ error: error.message || 'Could not update status.' });
  }
});

app.get('/api/artists/:artistId', async (req, res) => {
  try {
    const artistInfo = await getArtistInfo(req.params.artistId);
    if (!artistInfo) {
      return res.status(404).json({ error: 'Artist not found.' });
    }

    let allRegs = [];
    if (USE_MEGA) {
      allRegs = [
        ...(await listMegaRegistrationsFromRoot(megaRoots?.registeredRoot, 'Pending')),
        ...(await listMegaRegistrationsFromRoot(megaRoots?.approvedRoot, 'Approved')),
      ];
    } else {
      allRegs = [
        ...(await listLocalRegistrationsFromRoot('Registered', 'Pending')),
        ...(await listLocalRegistrationsFromRoot('Approved', 'Approved')),
      ];
    }

    const artistArtworks = allRegs.filter((item) => item.artistId === artistInfo.artistId);

    res.json({
      ok: true,
      artist: hydrateArtistInfo(artistInfo),
      artworks: artistArtworks,
    });
  } catch (error) {
    console.error('Get artist error:', error);
    res.status(500).json({ error: error.message || 'Could not load artist.' });
  }
});

// ── MEGA storage helpers ──

async function ensureMegaFolder(parent, name) {
  if (!parent) return null;
  const existing = findChild(parent, name, true);
  if (existing) return existing;
  try {
    return await parent.mkdir(name);
  } catch (err) {
    // mkdir failed — folder might already exist, reload children
    if (parent.children) {
      const recheck = findChild(parent, name, true);
      if (recheck) return recheck;
    }
    throw err;
  }
}

function findChild(parent, name, directory = null) {
  const children = Array.isArray(parent?.children) ? parent.children : [];
  return children.find((child) => {
    if (child.name !== name) return false;
    if (directory === null) return true;
    return Boolean(child.directory) === Boolean(directory);
  });
}

async function findOrCreateMegaArtist({ fullName, batch }) {
  const normalizedName = normalizeIdentityName(fullName);
  const folders = (megaRoots.artistsRoot.children || []).filter((c) => c.directory);

  for (const folder of folders) {
    const info = await readMegaJsonFile(folder, 'artist-info.json');
    if (!info) continue;
    if (normalizeIdentityName(info.fullName) === normalizedName && normalizeBatch(info.batch) === batch) {
      return { folder, info };
    }
  }

  const artistId = `ARTIST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const folder = await ensureMegaFolder(megaRoots.artistsRoot, artistId);
  await ensureMegaFolder(folder, 'profile');
  const now = new Date().toISOString();
  const info = {
    artistId,
    fullName: String(fullName || '').trim(),
    batch,
    profilePicture: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeMegaJsonFile(folder, 'artist-info.json', info);
  return { folder, info };
}

async function replaceMegaArtistProfilePicture(artistFolder, artistInfo, file) {
  const profileFolder = await ensureMegaFolder(artistFolder, 'profile');
  for (const child of [...(profileFolder.children || [])]) {
    if (!child.directory) await child.delete(true);
  }
  const extension = profileExtension(file.originalname, file.mimetype);
  const uploaded = await uploadTempFileToMega(profileFolder, file, `profile-picture${extension}`);
  return {
    ...artistInfo,
    profilePicture: megaFileMetadata(uploaded, file.originalname, file.mimetype),
    updatedAt: new Date().toISOString(),
  };
}

async function uploadTempFileToMega(folder, file, targetName) {
  const stream = fs.createReadStream(file.path);
  try {
    const uploadStream = folder.upload({ name: targetName, size: file.size }, stream);
    return await uploadStream.complete;
  } finally {
    stream.destroy();
  }
}

async function writeMegaJsonFile(folder, filename, data) {
  const existing = findChild(folder, filename, false);
  if (existing) await existing.delete(true);
  const json = `${JSON.stringify(data, null, 2)}\n`;
  return await folder.upload({ name: filename, size: Buffer.byteLength(json) }, Buffer.from(json, 'utf8')).complete;
}

async function readMegaJsonFile(folder, filename) {
  const file = findChild(folder, filename, false);
  if (!file) return null;
  const buffer = await file.downloadBuffer();
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

async function listMegaRegistrationsFromRoot(root, defaultStatus) {
  const output = [];
  for (const batchFolder of root.children || []) {
    if (!batchFolder.directory) continue;
    for (const artistFolder of batchFolder.children || []) {
      if (!artistFolder.directory) continue;
      const artistInfo = await getArtistInfo(artistFolder.name);
      for (const registrationFolder of artistFolder.children || []) {
        if (!registrationFolder.directory) continue;
        const registration = await readMegaJsonFile(registrationFolder, 'artwork-info.json');
        if (!registration) continue;
        output.push(hydrateRegistration({ ...registration, status: registration.status || defaultStatus }, artistInfo));
      }
    }
  }
  return output;
}

async function deleteMegaArtworkFiles(folder, files) {
  for (const fileInfo of files || []) {
    const megaFile = mega.files?.[fileInfo.nodeId];
    if (megaFile) {
      await megaFile.delete(true);
      continue;
    }
    const byName = findChild(folder, fileInfo.storedName, false);
    if (byName) await byName.delete(true);
  }
}

function getMegaNodeId(file) {
  const match = Object.entries(mega?.files || {}).find(([, candidate]) => candidate === file);
  return match?.[0] || '';
}

function megaFileMetadata(file, originalName, mimeType) {
  const nodeId = getMegaNodeId(file);
  return {
    nodeId,
    originalName: originalName || file.name,
    storedName: file.name,
    mimeType: mimeType || mimeTypeFromName(file.name),
    size: Number(file.size || 0),
    url: nodeId ? `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(nodeId)}` : '',
  };
}

// ── Local disk storage helpers ──

async function findOrCreateLocalArtist({ fullName, batch }) {
  const normalizedName = normalizeIdentityName(fullName);
  const artistsDir = path.join(LOCAL_STORAGE_DIR, 'Artists');
  await fsp.mkdir(artistsDir, { recursive: true });

  const entries = await fsp.readdir(artistsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(artistsDir, entry.name, 'artist-info.json');
    try {
      const info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
      if (normalizeIdentityName(info.fullName) === normalizedName && normalizeBatch(info.batch) === batch) {
        return { dir: path.join(artistsDir, entry.name), info };
      }
    } catch {}
  }

  const artistId = `ARTIST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const dir = path.join(artistsDir, artistId);
  await fsp.mkdir(path.join(dir, 'profile'), { recursive: true });
  const now = new Date().toISOString();
  const info = {
    artistId,
    fullName: String(fullName || '').trim(),
    batch,
    profilePicture: null,
    createdAt: now,
    updatedAt: now,
  };
  await fsp.writeFile(path.join(dir, 'artist-info.json'), JSON.stringify(info, null, 2), 'utf8');
  return { dir, info };
}

async function replaceLocalArtistProfilePicture(artistDir, artistInfo, file) {
  const profileDir = path.join(artistDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });
  const extension = profileExtension(file.originalname, file.mimetype);
  const fileName = `profile-picture${extension}`;
  const targetPath = path.join(profileDir, fileName);
  await fsp.copyFile(file.path, targetPath);
  const rel = path.relative(LOCAL_STORAGE_DIR, targetPath).replace(/\\/g, '/');

  return {
    ...artistInfo,
    profilePicture: {
      nodeId: rel,
      originalName: file.originalname,
      storedName: fileName,
      mimeType: file.mimetype,
      size: file.size,
      url: `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(rel)}`,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function listLocalRegistrationsFromRoot(rootName, defaultStatus) {
  const output = [];
  const rootDir = path.join(LOCAL_STORAGE_DIR, rootName);
  let batchEntries = [];
  try {
    batchEntries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const batchEntry of batchEntries) {
    if (!batchEntry.isDirectory()) continue;
    const batchDir = path.join(rootDir, batchEntry.name);
    let artistEntries = [];
    try {
      artistEntries = await fsp.readdir(batchDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const artistEntry of artistEntries) {
      if (!artistEntry.isDirectory()) continue;
      const artistDir = path.join(batchDir, artistEntry.name);
      const artistInfo = await getArtistInfo(artistEntry.name);
      let regEntries = [];
      try {
        regEntries = await fsp.readdir(artistDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const regEntry of regEntries) {
        if (!regEntry.isDirectory()) continue;
        const regInfoPath = path.join(artistDir, regEntry.name, 'artwork-info.json');
        try {
          const registration = JSON.parse(await fsp.readFile(regInfoPath, 'utf8'));
          output.push(hydrateRegistration({ ...registration, status: registration.status || defaultStatus }, artistInfo));
        } catch {}
      }
    }
  }
  return output;
}

// ── Generic resolution & hydration helpers ──

async function getArtistInfo(artistId) {
  if (!artistId) return null;
  if (USE_MEGA) {
    const folder = findChild(megaRoots?.artistsRoot, artistId, true);
    if (!folder) return null;
    return await readMegaJsonFile(folder, 'artist-info.json');
  } else {
    const infoPath = path.join(LOCAL_STORAGE_DIR, 'Artists', artistId, 'artist-info.json');
    try {
      return JSON.parse(await fsp.readFile(infoPath, 'utf8'));
    } catch {
      return null;
    }
  }
}

async function findRegistration(registrationId) {
  const id = String(registrationId || '').trim();
  if (!id) return null;

  if (USE_MEGA) {
    for (const root of [megaRoots?.registeredRoot, megaRoots?.approvedRoot]) {
      for (const batchFolder of root.children || []) {
        if (!batchFolder.directory) continue;
        for (const artistFolder of batchFolder.children || []) {
          if (!artistFolder.directory) continue;
          const folder = findChild(artistFolder, id, true);
          if (!folder) continue;
          const registration = await readMegaJsonFile(folder, 'artwork-info.json');
          if (registration) return { folder, registration };
        }
      }
    }
  } else {
    for (const rootName of ['Registered', 'Approved']) {
      const rootDir = path.join(LOCAL_STORAGE_DIR, rootName);
      let batches = [];
      try { batches = await fsp.readdir(rootDir, { withFileTypes: true }); } catch { continue; }
      for (const batch of batches) {
        if (!batch.isDirectory()) continue;
        const batchDir = path.join(rootDir, batch.name);
        let artists = [];
        try { artists = await fsp.readdir(batchDir, { withFileTypes: true }); } catch { continue; }
        for (const artist of artists) {
          if (!artist.isDirectory()) continue;
          const regDir = path.join(batchDir, artist.name, id);
          const infoPath = path.join(regDir, 'artwork-info.json');
          try {
            const registration = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
            return { dir: regDir, registration };
          } catch {}
        }
      }
    }
  }
  return null;
}

function hydrateArtistInfo(artistInfo) {
  if (!artistInfo) return null;
  return {
    ...artistInfo,
    profilePicture: hydrateFileMetadata(artistInfo.profilePicture),
  };
}

function hydrateRegistration(registration, artistInfo) {
  return {
    ...registration,
    student: {
      ...(registration.student || {}),
      fullName: artistInfo?.fullName || registration.student?.fullName || '',
      studentYear: artistInfo?.batch || registration.student?.studentYear || '',
      profilePicture: hydrateFileMetadata(artistInfo?.profilePicture || registration.student?.profilePicture || null),
    },
    files: (registration.files || []).map(hydrateFileMetadata),
  };
}

function hydrateFileMetadata(file) {
  if (!file) return null;
  return {
    ...file,
    url: file.nodeId ? `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(file.nodeId)}` : file.url || '',
  };
}

function validateArtistFields(body) {
  const required = [
    ['fullName', 'Artist full name'],
    ['studentYear', 'Batch'],
    ['artworkTitle', 'Artwork title'],
    ['category', 'Category'],
    ['medium', 'Medium'],
  ];

  for (const [key, label] of required) {
    if (!String(body?.[key] || '').trim()) {
      throw new Error(`${label} is required.`);
    }
  }
}

function normalizeBatch(value) {
  const text = String(value || '').trim();
  const match = text.match(/202[0-5]/);
  if (match) return `${match[0]} Batch`;
  const direct = BATCH_FOLDERS.find((batch) => batch.toLowerCase() === text.toLowerCase());
  return direct || text;
}

function normalizeIdentityName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function createRegistrationId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `ART-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const existing = await findRegistration(id);
    if (!existing) return id;
  }
  return `ART-${new Date().getFullYear()}-${crypto.randomUUID()}`;
}

function buildArtworkFilename(originalName, index) {
  const ext = path.extname(originalName).toLowerCase();
  const base = safeFilename(path.basename(originalName, ext), `artwork-${index}`).slice(0, 90);
  return `${String(index).padStart(2, '0')}-${base}${ext}`;
}

function safeFilename(value, fallback = 'file') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function profileExtension(originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext;
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function mimeTypeFromName(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function flattenIncomingFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat().filter(Boolean);
}

async function cleanupIncoming(files) {
  await Promise.all(
    (files || []).map(async (file) => {
      if (!file?.path) return;
      try {
        await fsp.unlink(file.path);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn('Temporary file cleanup failed:', error.message);
        }
      }
    })
  );
}

function normalizeReviewStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'approved' || text === 'approve') return 'Approved';
  if (text === 'rejected' || text === 'reject') return 'Rejected';
  if (text === 'pending') return 'Pending';
  return '';
}

app.use((error, req, res, next) => {
  console.error('Request error:', error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message, field: error.field || null });
  }
  res.status(400).json({ error: error.message || 'Bad request.' });
});


// ── Build and publish admin-data.json ──
async function publishAdminDataToGitHub() {
  try {
    const { buildAdminData } = await import('./scripts/buildAdminData.js');
    const data = buildAdminData();
    const json = JSON.stringify(data, null, 2);
    const outputPath = path.resolve(ROOT_DIR, 'admin-data.json');
    await fsp.writeFile(outputPath, json, 'utf8');
    console.log('[publishAdminDataToGitHub] Wrote admin-data.json locally');
    await execFile('git', ['-C', ROOT_DIR, 'add', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, '-c', 'user.name=exhibition-bot', '-c', 'user.email=bot@exhibition', 'commit', '-m', 'chore: update admin-data.json', 'admin-data.json']);
    await execFile('git', ['-C', ROOT_DIR, 'push', 'origin', 'main']);
    console.log('[publishAdminDataToGitHub] Pushed admin-data.json to GitHub');
  } catch (err) {
    console.error('[publishAdminDataToGitHub] Failed:', err.message);
  }
}

app.get('/api/admin-data/build', async (req, res) => {
  try {
    await publishAdminDataToGitHub();
    res.json({ ok: true, message: 'admin-data.json rebuilt and pushed.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fine Arts Exhibition API running on port ${PORT}`);
  console.log(`Storage Mode: ${USE_MEGA ? 'MEGA' : 'Local Disk (' + LOCAL_STORAGE_DIR + ')'}`);
});


