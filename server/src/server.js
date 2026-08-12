import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { Storage } from 'megajs';

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

const ARTWORK_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

const PROFILE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  throw new Error(
    'MEGA_EMAIL and MEGA_PASSWORD must be set in the server environment.'
  );
}

const TEMP_DIR = path.join(os.tmpdir(), 'fine-arts-exhibition-incoming');
await fsp.mkdir(TEMP_DIR, { recursive: true });

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: 11,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'profilePicture') {
      if (!PROFILE_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error('Profile picture must be JPG, PNG, or WEBP.'));
      }
      return cb(null, true);
    }

    if (file.fieldname === 'artworkFiles') {
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
]);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

let mega = null;
let megaRoots = null;

async function connectMega() {
  if (mega && megaRoots) return mega;

  mega = await new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  }).ready;

  const exhibitionRoot = await ensureFolder(mega.root, MEGA_ROOT_FOLDER);
  const artistsRoot = await ensureFolder(exhibitionRoot, 'Artists');
  const registeredRoot = await ensureFolder(exhibitionRoot, 'Registered');
  const approvedRoot = await ensureFolder(exhibitionRoot, 'Approved');

  for (const batch of BATCH_FOLDERS) {
    await ensureFolder(registeredRoot, batch);
    await ensureFolder(approvedRoot, batch);
  }

  megaRoots = {
    exhibitionRoot,
    artistsRoot,
    registeredRoot,
    approvedRoot,
  };

  return mega;
}

await connectMega();

app.get('/api/health', async (req, res) => {
  try {
    await connectMega();

    res.json({
      ok: true,
      service: 'fine-arts-exhibition-api',
      permanentStorage: 'MEGA',
      megaRootFolder: MEGA_ROOT_FOLDER,
      batches: BATCH_FOLDERS,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message || 'MEGA connection failed.',
    });
  }
});

app.get('/api/registrations', async (req, res) => {
  try {
    await connectMega();

    const registrations = [
      ...(await listRegistrationsFromRoot(megaRoots.registeredRoot, 'Pending')),
      ...(await listRegistrationsFromRoot(megaRoots.approvedRoot, 'Approved')),
    ];

    registrations.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(
        String(a.updatedAt || a.createdAt || '')
      )
    );

    res.json({
      ok: true,
      count: registrations.length,
      registrations,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Could not load registrations from MEGA.',
    });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const registered = await listRegistrationsFromRoot(
      megaRoots.registeredRoot,
      'Pending'
    );

    const approved = await listRegistrationsFromRoot(
      megaRoots.approvedRoot,
      'Approved'
    );

    res.json({
      ok: true,
      totalArtworksRegistered: registered.length + approved.length,
      pending: registered.length,
      approved: approved.length,
      updatedAt: new Date().toISOString(),
      source: 'MEGA',
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Could not calculate stats.',
    });
  }
});

app.get('/api/media/:nodeId', async (req, res) => {
  try {
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

    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not download MEGA file.' });
      } else {
        res.destroy(error);
      }
    });

    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Could not download file.',
    });
  }
});

app.post('/api/registrations', registrationUpload, async (req, res) => {
  const incomingFiles = flattenIncomingFiles(req.files);

  try {
    validateArtistFields(req.body);

    const artworkUploads = req.files?.artworkFiles || [];
    const profileUploads = req.files?.profilePicture || [];

    if (!artworkUploads.length) {
      return res.status(400).json({
        error: 'Please upload at least one artwork file.',
      });
    }

    const batch = normalizeBatch(req.body.studentYear);

    if (!BATCH_FOLDERS.includes(batch)) {
      return res.status(400).json({
        error: 'Select a batch from 2020 Batch to 2025 Batch.',
      });
    }

    const category =
      req.body.category === 'Other'
        ? String(req.body.otherCategory || '').trim()
        : String(req.body.category || '').trim();

    const artist = await findOrCreateArtist({
      fullName: req.body.fullName,
      batch,
    });

    let artistInfo = artist.info;

    if (profileUploads.length) {
      artistInfo = await replaceArtistProfilePicture(
        artist.folder,
        artistInfo,
        profileUploads[0]
      );
    }

    artistInfo = {
      ...artistInfo,
      fullName: String(req.body.fullName || '').trim(),
      batch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFile(artist.folder, 'artist-info.json', artistInfo);

    const registrationId = await createRegistrationId();

    const registeredBatchFolder = await ensureFolder(
      megaRoots.registeredRoot,
      batch
    );

    const artistArtworkRoot = await ensureFolder(
      registeredBatchFolder,
      artistInfo.artistId
    );

    const registrationFolder = await ensureFolder(
      artistArtworkRoot,
      registrationId
    );

    const storedArtworkFiles = [];

    for (let index = 0; index < artworkUploads.length; index += 1) {
      const file = artworkUploads[index];

      const storedName = buildArtworkFilename(
        file.originalname,
        index + 1
      );

      const uploaded = await uploadTempFileToMega(
        registrationFolder,
        file,
        storedName
      );

      storedArtworkFiles.push(
        megaFileMetadata(uploaded, file.originalname, file.mimetype)
      );
    }

    const now = new Date().toISOString();

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
    };

    await writeJsonFile(
      registrationFolder,
      'artwork-info.json',
      registration
    );

    res.status(201).json({
      ok: true,
      id: registrationId,
      artistId: artistInfo.artistId,
      registration: hydrateRegistration(registration, artistInfo),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Registration failed.',
    });
  } finally {
    await cleanupIncoming(incomingFiles);
  }
});

app.get('/api/registrations/:id', async (req, res) => {
  try {
    const found = await findRegistration(req.params.id);

    if (!found) {
      return res.status(404).json({
        error: 'Registration not found.',
      });
    }

    const artistInfo = await getArtistInfo(found.registration.artistId);

    res.json({
      ok: true,
      registration: hydrateRegistration(found.registration, artistInfo),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Could not load registration.',
    });
  }
});

app.put('/api/registrations/:id', registrationUpload, async (req, res) => {
  const incomingFiles = flattenIncomingFiles(req.files);

  try {
    const found = await findRegistration(req.params.id);

    if (!found) {
      return res.status(404).json({
        error: 'Registration not found.',
      });
    }

    const existing = found.registration;
    let artistInfo = await getArtistInfo(existing.artistId);

    const profileUploads = req.files?.profilePicture || [];
    const artworkUploads = req.files?.artworkFiles || [];

    const artistFolder = findChild(
      megaRoots.artistsRoot,
      existing.artistId,
      true
    );

    if (profileUploads.length) {
      artistInfo = await replaceArtistProfilePicture(
        artistFolder,
        artistInfo,
        profileUploads[0]
      );
    }

    if (req.body.fullName !== undefined) {
      artistInfo.fullName = String(req.body.fullName || '').trim();
    }

    if (req.body.studentYear !== undefined) {
      artistInfo.batch = normalizeBatch(req.body.studentYear);
    }

    artistInfo.updatedAt = new Date().toISOString();

    await writeJsonFile(artistFolder, 'artist-info.json', artistInfo);

    let files = existing.files || [];

    if (artworkUploads.length) {
      await deleteArtworkFiles(found.folder, files);

      files = [];

      for (let index = 0; index < artworkUploads.length; index += 1) {
        const file = artworkUploads[index];

        const uploaded = await uploadTempFileToMega(
          found.folder,
          file,
          buildArtworkFilename(file.originalname, index + 1)
        );

        files.push(
          megaFileMetadata(uploaded, file.originalname, file.mimetype)
        );
      }
    }

    const updated = {
      ...existing,
      updatedAt: new Date().toISOString(),

      student: {
        fullName: artistInfo.fullName,
        studentYear: artistInfo.batch,
        profilePicture: artistInfo.profilePicture || null,
      },

      artwork: {
        title: bodyValue(
          req.body,
          'artworkTitle',
          existing.artwork?.title || ''
        ),
        category: bodyValue(
          req.body,
          'category',
          existing.artwork?.category || ''
        ),
        medium: bodyValue(
          req.body,
          'medium',
          existing.artwork?.medium || ''
        ),
        dimensions: bodyValue(
          req.body,
          'dimensions',
          existing.artwork?.dimensions || ''
        ),
        description: bodyValue(
          req.body,
          'description',
          existing.artwork?.description || ''
        ),
      },

      files,
    };

    await writeJsonFile(
      found.folder,
      'artwork-info.json',
      updated
    );

    res.json({
      ok: true,
      registration: hydrateRegistration(updated, artistInfo),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Registration update failed.',
    });
  } finally {
    await cleanupIncoming(incomingFiles);
  }
});

app.patch('/api/registrations/:id/review', async (req, res) => {
  try {
    const requestedStatus = normalizeReviewStatus(req.body?.status);

    if (!requestedStatus) {
      return res.status(400).json({
        error: 'Status must be Approved, Rejected, or Pending.',
      });
    }

    const found = await findRegistration(req.params.id);

    if (!found) {
      return res.status(404).json({
        error: 'Registration not found.',
      });
    }

    const registration = {
      ...found.registration,
      status: requestedStatus,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const desiredRoot =
      requestedStatus === 'Approved'
        ? megaRoots.approvedRoot
        : megaRoots.registeredRoot;

    const batch = normalizeBatch(
      registration.student?.studentYear
    );

    const batchFolder = await ensureFolder(desiredRoot, batch);
    const artistFolder = await ensureFolder(
      batchFolder,
      registration.artistId
    );

    if (found.folder.parent !== artistFolder) {
      await found.folder.moveTo(artistFolder);
    }

    await writeJsonFile(
      found.folder,
      'artwork-info.json',
      registration
    );

    res.json({
      ok: true,
      status: requestedStatus,
      registration,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Could not update review status.',
    });
  }
});

async function ensureFolder(parent, name) {
  const existing = findChild(parent, name, true);
  if (existing) return existing;
  return await parent.mkdir(name);
}

function findChild(parent, name, directory = null) {
  const children = parent?.children || [];

  return children.find((child) => {
    if (child.name !== name) return false;
    if (directory === null) return true;
    return Boolean(child.directory) === Boolean(directory);
  });
}

async function findOrCreateArtist({ fullName, batch }) {
  const normalizedName = normalizeIdentityName(fullName);

  for (const folder of megaRoots.artistsRoot.children || []) {
    if (!folder.directory) continue;

    const info = await readJsonFile(folder, 'artist-info.json');
    if (!info) continue;

    if (
      normalizeIdentityName(info.fullName) === normalizedName &&
      normalizeBatch(info.batch) === batch
    ) {
      return { folder, info };
    }
  }

  const artistId =
    `ARTIST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const folder = await ensureFolder(
    megaRoots.artistsRoot,
    artistId
  );

  const now = new Date().toISOString();

  const info = {
    artistId,
    fullName: String(fullName || '').trim(),
    batch,
    profilePicture: null,
    createdAt: now,
    updatedAt: now,
  };

  await writeJsonFile(folder, 'artist-info.json', info);
  await ensureFolder(folder, 'profile');

  return { folder, info };
}

async function getArtistInfo(artistId) {
  const folder = findChild(
    megaRoots.artistsRoot,
    artistId,
    true
  );

  if (!folder) return null;

  return await readJsonFile(folder, 'artist-info.json');
}

async function replaceArtistProfilePicture(
  artistFolder,
  artistInfo,
  file
) {
  const profileFolder = await ensureFolder(
    artistFolder,
    'profile'
  );

  for (const child of [...(profileFolder.children || [])]) {
    if (!child.directory) {
      await child.delete(true);
    }
  }

  const ext = profileExtension(
    file.originalname,
    file.mimetype
  );

  const uploaded = await uploadTempFileToMega(
    profileFolder,
    file,
    `profile-picture${ext}`
  );

  return {
    ...artistInfo,
    profilePicture: megaFileMetadata(
      uploaded,
      file.originalname,
      file.mimetype
    ),
  };
}

async function uploadTempFileToMega(folder, file, targetName) {
  const stream = fs.createReadStream(file.path);

  const uploadStream = folder.upload(
    {
      name: targetName,
      size: file.size,
    },
    stream
  );

  return await uploadStream.complete;
}

async function writeJsonFile(folder, filename, data) {
  const existing = findChild(folder, filename, false);

  if (existing) {
    await existing.delete(true);
  }

  const json = `${JSON.stringify(data, null, 2)}\n`;

  return await folder.upload(
    {
      name: filename,
      size: Buffer.byteLength(json),
    },
    Buffer.from(json)
  ).complete;
}

async function readJsonFile(folder, filename) {
  const file = findChild(folder, filename, false);
  if (!file) return null;

  const buffer = await file.downloadBuffer();

  return JSON.parse(buffer.toString('utf8'));
}

async function findRegistration(id) {
  for (const root of [
    megaRoots.registeredRoot,
    megaRoots.approvedRoot,
  ]) {
    for (const batchFolder of root.children || []) {
      if (!batchFolder.directory) continue;

      for (const artistFolder of batchFolder.children || []) {
        if (!artistFolder.directory) continue;

        const registrationFolder = findChild(
          artistFolder,
          id,
          true
        );

        if (!registrationFolder) continue;

        const registration = await readJsonFile(
          registrationFolder,
          'artwork-info.json'
        );

        if (registration) {
          return {
            folder: registrationFolder,
            registration,
          };
        }
      }
    }
  }

  return null;
}

async function listRegistrationsFromRoot(root, defaultStatus) {
  const registrations = [];

  for (const batchFolder of root.children || []) {
    if (!batchFolder.directory) continue;

    for (const artistFolder of batchFolder.children || []) {
      if (!artistFolder.directory) continue;

      const artistInfo = await getArtistInfo(artistFolder.name);

      for (const folder of artistFolder.children || []) {
        if (!folder.directory) continue;

        const registration = await readJsonFile(
          folder,
          'artwork-info.json'
        );

        if (registration) {
          registrations.push(
            hydrateRegistration(
              {
                ...registration,
                status: registration.status || defaultStatus,
              },
              artistInfo
            )
          );
        }
      }
    }
  }

  return registrations;
}

async function deleteArtworkFiles(folder, files) {
  for (const fileInfo of files || []) {
    const megaFile = mega.files?.[fileInfo.nodeId];

    if (megaFile) {
      await megaFile.delete(true);
    }
  }
}

function megaFileMetadata(file, originalName, mimeType) {
  const nodeId =
    Object.entries(mega.files || {}).find(
      ([, candidate]) => candidate === file
    )?.[0] || '';

  return {
    nodeId,
    originalName,
    storedName: file.name,
    mimeType,
    size: file.size || 0,
    url: nodeId
      ? `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(nodeId)}`
      : '',
  };
}

function hydrateRegistration(registration, artistInfo) {
  return {
    ...registration,

    student: {
      ...(registration.student || {}),
      fullName:
        artistInfo?.fullName ||
        registration.student?.fullName ||
        '',
      studentYear:
        artistInfo?.batch ||
        registration.student?.studentYear ||
        '',
      profilePicture:
        artistInfo?.profilePicture ||
        registration.student?.profilePicture ||
        null,
    },
  };
}

function validateArtistFields(body) {
  const required = [
    'fullName',
    'studentYear',
    'artworkTitle',
    'category',
    'medium',
  ];

  for (const key of required) {
    if (!String(body?.[key] || '').trim()) {
      throw new Error(`${key} is required.`);
    }
  }
}

function normalizeBatch(value) {
  const text = String(value || '').trim();

  const match = text.match(/202[0-5]/);

  return match
    ? `${match[0]} Batch`
    : text;
}

function normalizeIdentityName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

async function createRegistrationId() {
  return `ART-${new Date().getFullYear()}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;
}

function buildArtworkFilename(originalName, index) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);

  return `${String(index).padStart(2, '0')}-${base}${ext}`;
}

function profileExtension(originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase();

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return ext;
  }

  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';

  return '.jpg';
}

function mimeTypeFromName(filename) {
  const ext = path.extname(filename || '').toLowerCase();

  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';

  return 'application/octet-stream';
}

function flattenIncomingFiles(files) {
  if (!files) return [];
  return Object.values(files).flat();
}

async function cleanupIncoming(files) {
  await Promise.all(
    files.map(async (file) => {
      try {
        await fsp.unlink(file.path);
      } catch {}
    })
  );
}

function bodyValue(body, key, fallback) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
    return fallback;
  }

  return String(body[key] ?? '').trim();
}

function normalizeReviewStatus(value) {
  const text = String(value || '').trim().toLowerCase();

  if (text === 'approved' || text === 'approve') return 'Approved';
  if (text === 'rejected' || text === 'reject') return 'Rejected';
  if (text === 'pending') return 'Pending';

  return '';
}

app.use((error, req, res, next) => {
  console.error(error);

  res.status(400).json({
    error: error.message || 'Bad request.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fine Arts Exhibition API running on port ${PORT}`);
  console.log('Permanent storage: MEGA only');
});
