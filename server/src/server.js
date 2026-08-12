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
  throw new Error('MEGA_EMAIL and MEGA_PASSWORD must be set.');
}

const TEMP_DIR = path.join(
  os.tmpdir(),
  'fine-arts-exhibition-incoming'
);

await fsp.mkdir(TEMP_DIR, { recursive: true });

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(
      null,
      `${Date.now()}-${crypto.randomUUID()}${ext}`
    );
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
        return cb(
          new Error(
            'Profile picture must be JPG, PNG, or WEBP.'
          )
        );
      }

      return cb(null, true);
    }

    if (
      file.fieldname === 'artworkFiles' ||
      file.fieldname === 'artworkFiles[]'
    ) {
      if (!ARTWORK_MIME_TYPES.has(file.mimetype)) {
        return cb(
          new Error(
            'Artwork files must be JPG, PNG, or PDF.'
          )
        );
      }

      return cb(null, true);
    }

    return cb(
      new Error(
        `Unexpected upload field: ${file.fieldname}`
      )
    );
  },
});

const registrationUpload = upload.fields([
  {
    name: 'profilePicture',
    maxCount: 1,
  },
  {
    name: 'artworkFiles',
    maxCount: 10,
  },
  {
    name: 'artworkFiles[]',
    maxCount: 10,
  },
]);

app.use(cors({ origin: '*' }));

app.use(
  express.json({
    limit: '2mb',
  })
);

let mega = null;

let megaRoots = null;

async function connectMega() {
  if (mega && megaRoots) {
    return mega;
  }

  console.log('Connecting to MEGA...');

  mega = await new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  }).ready;

  const exhibitionRoot = await ensureFolder(
    mega.root,
    MEGA_ROOT_FOLDER
  );

  const artistsRoot = await ensureFolder(
    exhibitionRoot,
    'Artists'
  );

  const registeredRoot = await ensureFolder(
    exhibitionRoot,
    'Registered'
  );

  const approvedRoot = await ensureFolder(
    exhibitionRoot,
    'Approved'
  );

  for (const batch of BATCH_FOLDERS) {
    await ensureFolder(
      registeredRoot,
      batch
    );

    await ensureFolder(
      approvedRoot,
      batch
    );
  }

  megaRoots = {
    exhibitionRoot,
    artistsRoot,
    registeredRoot,
    approvedRoot,
  };

  console.log('Connected to MEGA');

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
      error:
        error.message ||
        'MEGA connection failed.',
    });
  }
});

app.get('/api/registrations', async (req, res) => {
  try {
    await connectMega();

    const pending = await listRegistrationsFromRoot(
      megaRoots.registeredRoot,
      'Pending'
    );

    const approved = await listRegistrationsFromRoot(
      megaRoots.approvedRoot,
      'Approved'
    );

    const registrations = [
      ...pending,
      ...approved,
    ];

    registrations.sort((a, b) => {
      const aDate =
        a.updatedAt ||
        a.createdAt ||
        '';

      const bDate =
        b.updatedAt ||
        b.createdAt ||
        '';

      return String(bDate).localeCompare(
        String(aDate)
      );
    });

    res.json({
      ok: true,
      count: registrations.length,
      registrations,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        error.message ||
        'Could not load registrations.',
    });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const pending =
      await listRegistrationsFromRoot(
        megaRoots.registeredRoot,
        'Pending'
      );

    const approved =
      await listRegistrationsFromRoot(
        megaRoots.approvedRoot,
        'Approved'
      );

    res.json({
      ok: true,
      totalArtworksRegistered:
        pending.length +
        approved.length,

      pending: pending.length,

      approved:
        approved.length,

      updatedAt:
        new Date().toISOString(),

      source: 'MEGA',
    });
  } catch (error) {
    res.status(500).json({
      error:
        error.message ||
        'Could not calculate stats.',
    });
  }
});

app.get('/api/media/:nodeId', async (req, res) => {
  try {
    const storage = await connectMega();

    let file =
      storage.files?.[
        req.params.nodeId
      ];

    if (!file) {
      await storage.reload();

      file =
        storage.files?.[
          req.params.nodeId
        ];
    }

    if (!file || file.directory) {
      return res.status(404).json({
        error: 'File not found.',
      });
    }

    res.setHeader(
      'Content-Type',
      mimeTypeFromName(
        file.name
      )
    );

    res.setHeader(
      'Cache-Control',
      'private, max-age=300'
    );

    const stream =
      file.download();

    stream.on(
      'error',
      (error) => {
        console.error(
          'MEGA stream error:',
          error
        );

        if (
          !res.headersSent
        ) {
          res.status(500).json({
            error:
              'Could not download file.',
          });
        } else {
          res.destroy(
            error
          );
        }
      }
    );

    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error:
        error.message ||
        'Could not load media.',
    });
  }
});

app.post(
  '/api/registrations',
  registrationUpload,
  async (req, res) => {
    const incomingFiles =
      flattenIncomingFiles(
        req.files
      );

    try {
      await connectMega();

      validateArtistFields(
        req.body
      );

      const artworkUploads = [
        ...(req.files?.artworkFiles ||
          []),
        ...(req.files?.[
          'artworkFiles[]'
        ] || []),
      ];

      const profileUploads =
        req.files
          ?.profilePicture ||
        [];

      if (
        !artworkUploads.length
      ) {
        return res.status(400).json({
          error:
            'Please upload at least one artwork file.',
        });
      }

      const batch =
        normalizeBatch(
          req.body.studentYear
        );

      if (
        !BATCH_FOLDERS.includes(
          batch
        )
      ) {
        return res.status(400).json({
          error:
            'Select a batch from 2020 Batch to 2025 Batch.',
        });
      }

      const category =
        req.body.category ===
        'Other'
          ? String(
              req.body
                .otherCategory ||
                ''
            ).trim()
          : String(
              req.body.category ||
                ''
            ).trim();

      if (!category) {
        return res.status(400).json({
          error:
            'Artwork category is required.',
        });
      }

      const artist =
        await findOrCreateArtist({
          fullName:
            req.body.fullName,
          batch,
        });

      let artistInfo =
        artist.info;

      if (
        profileUploads.length
      ) {
        artistInfo =
          await replaceArtistProfilePicture(
            artist.folder,
            artistInfo,
            profileUploads[0]
          );
      }

      artistInfo = {
        ...artistInfo,

        fullName:
          String(
            req.body.fullName ||
              ''
          ).trim(),

        batch,

        updatedAt:
          new Date().toISOString(),
      };

      await writeJsonFile(
        artist.folder,
        'artist-info.json',
        artistInfo
      );

      const registrationId =
        await createRegistrationId();

      const batchFolder =
        await ensureFolder(
          megaRoots.registeredRoot,
          batch
        );

      const artistArtworkRoot =
        await ensureFolder(
          batchFolder,
          artistInfo.artistId
        );

      const registrationFolder =
        await ensureFolder(
          artistArtworkRoot,
          registrationId
        );

      const storedArtworkFiles =
        [];

      for (
        let index = 0;
        index <
        artworkUploads.length;
        index += 1
      ) {
        const file =
          artworkUploads[index];

        const storedName =
          buildArtworkFilename(
            file.originalname,
            index + 1
          );

        const uploaded =
          await uploadTempFileToMega(
            registrationFolder,
            file,
            storedName
          );

        storedArtworkFiles.push(
          megaFileMetadata(
            uploaded,
            file.originalname,
            file.mimetype
          )
        );
      }

      const now =
        new Date().toISOString();

      const registration = {
        id:
          registrationId,

        artistId:
          artistInfo.artistId,

        status:
          'Pending',

        createdAt:
          now,

        updatedAt:
          now,

        student: {
          fullName:
            artistInfo.fullName,

          studentYear:
            artistInfo.batch,

          profilePicture:
            artistInfo.profilePicture ||
            null,
        },

        artwork: {
          title:
            String(
              req.body
                .artworkTitle ||
                ''
            ).trim(),

          category,

          medium:
            String(
              req.body.medium ||
                ''
            ).trim(),

          dimensions:
            String(
              req.body
                .dimensions ||
                ''
            ).trim(),

          description:
            String(
              req.body
                .description ||
                ''
            ).trim(),
        },

        files:
          storedArtworkFiles,

        storage: {
          provider:
            'MEGA',

          state:
            'Registered',

          batch,

          artistId:
            artistInfo.artistId,

          registrationId,
        },
      };

      await writeJsonFile(
        registrationFolder,
        'artwork-info.json',
        registration
      );

      res.status(201).json({
        ok: true,

        id:
          registrationId,

        artistId:
          artistInfo.artistId,

        registration:
          hydrateRegistration(
            registration,
            artistInfo
          ),
      });
    } catch (error) {
      console.error(
        'Registration error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Registration failed.',
      });
    } finally {
      await cleanupIncoming(
        incomingFiles
      );
    }
  }
);

app.get(
  '/api/registrations/:id',
  async (req, res) => {
    try {
      const found =
        await findRegistration(
          req.params.id
        );

      if (!found) {
        return res.status(404).json({
          error:
            'Registration not found.',
        });
      }

      const artistInfo =
        await getArtistInfo(
          found.registration
            .artistId
        );

      res.json({
        ok: true,

        id:
          found.registration.id,

        registration:
          hydrateRegistration(
            found.registration,
            artistInfo
          ),
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          'Could not load registration.',
      });
    }
  }
);

app.put(
  '/api/registrations/:id',
  registrationUpload,
  async (req, res) => {
    const incomingFiles =
      flattenIncomingFiles(
        req.files
      );

    try {
      const found =
        await findRegistration(
          req.params.id
        );

      if (!found) {
        return res.status(404).json({
          error:
            'Registration not found.',
        });
      }

      const existing =
        found.registration;

      let artistInfo =
        await getArtistInfo(
          existing.artistId
        );

      if (!artistInfo) {
        throw new Error(
          'Artist profile not found.'
        );
      }

      const profileUploads =
        req.files
          ?.profilePicture ||
        [];

      const artworkUploads = [
        ...(req.files?.artworkFiles ||
          []),

        ...(req.files?.[
          'artworkFiles[]'
        ] || []),
      ];

      const artistFolder =
        findChild(
          megaRoots.artistsRoot,
          existing.artistId,
          true
        );

      if (!artistFolder) {
        throw new Error(
          'Artist folder not found.'
        );
      }

      if (
        profileUploads.length
      ) {
        artistInfo =
          await replaceArtistProfilePicture(
            artistFolder,
            artistInfo,
            profileUploads[0]
          );
      }

      if (
        req.body.fullName !==
        undefined
      ) {
        const fullName =
          String(
            req.body.fullName ||
              ''
          ).trim();

        if (!fullName) {
          return res.status(400).json({
            error:
              'Artist name cannot be empty.',
          });
        }

        artistInfo.fullName =
          fullName;
      }

      if (
        req.body.studentYear !==
        undefined
      ) {
        const batch =
          normalizeBatch(
            req.body.studentYear
          );

        if (
          !BATCH_FOLDERS.includes(
            batch
          )
        ) {
          return res.status(400).json({
            error:
              'Select a batch from 2020 Batch to 2025 Batch.',
          });
        }

        artistInfo.batch =
          batch;
      }

      artistInfo.updatedAt =
        new Date().toISOString();

      await writeJsonFile(
        artistFolder,
        'artist-info.json',
        artistInfo
      );

      let files =
        Array.isArray(
          existing.files
        )
          ? existing.files
          : [];

      if (
        artworkUploads.length
      ) {
        await deleteArtworkFiles(
          found.folder,
          files
        );

        files = [];

        for (
          let index = 0;
          index <
          artworkUploads.length;
          index += 1
        ) {
          const file =
            artworkUploads[index];

          const uploaded =
            await uploadTempFileToMega(
              found.folder,
              file,
              buildArtworkFilename(
                file.originalname,
                index + 1
              )
            );

          files.push(
            megaFileMetadata(
              uploaded,
              file.originalname,
              file.mimetype
            )
          );
        }
      }

      const updated = {
        ...existing,

        updatedAt:
          new Date().toISOString(),

        student: {
          fullName:
            artistInfo.fullName,

          studentYear:
            artistInfo.batch,

          profilePicture:
            artistInfo.profilePicture ||
            null,
        },

        artwork: {
          title:
            bodyValue(
              req.body,
              'artworkTitle',
              existing.artwork
                ?.title ||
                ''
            ),

          category:
            bodyValue(
              req.body,
              'category',
              existing.artwork
                ?.category ||
                ''
            ),

          medium:
            bodyValue(
              req.body,
              'medium',
              existing.artwork
                ?.medium ||
                ''
            ),

          dimensions:
            bodyValue(
              req.body,
              'dimensions',
              existing.artwork
                ?.dimensions ||
                ''
            ),

          description:
            bodyValue(
              req.body,
              'description',
              existing.artwork
                ?.description ||
                ''
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

        id:
          updated.id,

        artistId:
          artistInfo.artistId,

        registration:
          hydrateRegistration(
            updated,
            artistInfo
          ),
      });
    } catch (error) {
      console.error(
        'Update error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Registration update failed.',
      });
    } finally {
      await cleanupIncoming(
        incomingFiles
      );
    }
  }
);

app.patch(
  '/api/registrations/:id/review',
  async (req, res) => {
    try {
      const requestedStatus =
        normalizeReviewStatus(
          req.body?.status
        );

      if (
        !requestedStatus
      ) {
        return res.status(400).json({
          error:
            'Status must be Approved, Rejected, or Pending.',
        });
      }

      const found =
        await findRegistration(
          req.params.id
        );

      if (!found) {
        return res.status(404).json({
          error:
            'Registration not found.',
        });
      }

      const registration = {
        ...found.registration,

        status:
          requestedStatus,

        reviewedAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString(),
      };

      const desiredRoot =
        requestedStatus ===
        'Approved'
          ? megaRoots.approvedRoot
          : megaRoots.registeredRoot;

      const batch =
        normalizeBatch(
          registration.student
            ?.studentYear
        );

      const batchFolder =
        await ensureFolder(
          desiredRoot,
          batch
        );

      const artistFolder =
        await ensureFolder(
          batchFolder,
          registration.artistId
        );

      if (
        found.folder.parent !==
        artistFolder
      ) {
        const existing =
          findChild(
            artistFolder,
            registration.id,
            true
          );

        if (
          existing &&
          existing !==
            found.folder
        ) {
          await existing.delete(
            true
          );
        }

        await found.folder.moveTo(
          artistFolder
        );
      }

      registration.storage = {
        ...(registration.storage ||
          {}),

        provider:
          'MEGA',

        state:
          requestedStatus ===
          'Approved'
            ? 'Approved'
            : 'Registered',

        batch,

        artistId:
          registration.artistId,

        registrationId:
          registration.id,
      };

      await writeJsonFile(
        found.folder,
        'artwork-info.json',
        registration
      );

      const artistInfo =
        await getArtistInfo(
          registration.artistId
        );

      res.json({
        ok: true,

        id:
          registration.id,

        status:
          requestedStatus,

        registration:
          hydrateRegistration(
            registration,
            artistInfo
          ),
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          'Could not update status.',
      });
    }
  }
);

app.get(
  '/api/artists/:artistId',
  async (req, res) => {
    try {
      const artistInfo =
        await getArtistInfo(
          req.params.artistId
        );

      if (!artistInfo) {
        return res.status(404).json({
          error:
            'Artist not found.',
        });
      }

      const registrations = [
        ...(await listRegistrationsFromRoot(
          megaRoots.registeredRoot,
          'Pending'
        )),

        ...(await listRegistrationsFromRoot(
          megaRoots.approvedRoot,
          'Approved'
        )),
      ].filter(
        (item) =>
          item.artistId ===
          artistInfo.artistId
      );

      res.json({
        ok: true,
        artist:
          hydrateArtistInfo(
            artistInfo
          ),
        artworks:
          registrations,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          'Could not load artist.',
      });
    }
  }
);

async function ensureFolder(
  parent,
  name
) {
  const existing =
    findChild(
      parent,
      name,
      true
    );

  if (existing) {
    return existing;
  }

  return await parent.mkdir(
    name
  );
}

function findChild(
  parent,
  name,
  directory = null
) {
  const children =
    Array.isArray(
      parent?.children
    )
      ? parent.children
      : [];

  return children.find(
    (child) => {
      if (
        child.name !== name
      ) {
        return false;
      }

      if (
        directory === null
      ) {
        return true;
      }

      return (
        Boolean(
          child.directory
        ) ===
        Boolean(directory)
      );
    }
  );
}

async function findOrCreateArtist({
  fullName,
  batch,
}) {
  const normalizedName =
    normalizeIdentityName(
      fullName
    );

  const folders =
    (
      megaRoots.artistsRoot
        .children ||
      []
    ).filter(
      (child) =>
        child.directory
    );

  for (
    const folder of
    folders
  ) {
    const info =
      await readJsonFile(
        folder,
        'artist-info.json'
      );

    if (!info) {
      continue;
    }

    if (
      normalizeIdentityName(
        info.fullName
      ) ===
        normalizedName &&
      normalizeBatch(
        info.batch
      ) === batch
    ) {
      return {
        folder,
        info,
      };
    }
  }

  const artistId =
    `ARTIST-${crypto
      .randomBytes(6)
      .toString('hex')
      .toUpperCase()}`;

  const folder =
    await ensureFolder(
      megaRoots.artistsRoot,
      artistId
    );

  await ensureFolder(
    folder,
    'profile'
  );

  const now =
    new Date().toISOString();

  const info = {
    artistId,

    fullName:
      String(
        fullName ||
          ''
      ).trim(),

    batch,

    profilePicture:
      null,

    createdAt:
      now,

    updatedAt:
      now,
  };

  await writeJsonFile(
    folder,
    'artist-info.json',
    info
  );

  return {
    folder,
    info,
  };
}

async function getArtistInfo(
  artistId
) {
  if (!artistId) {
    return null;
  }

  const folder =
    findChild(
      megaRoots.artistsRoot,
      artistId,
      true
    );

  if (!folder) {
    return null;
  }

  return await readJsonFile(
    folder,
    'artist-info.json'
  );
}

async function replaceArtistProfilePicture(
  artistFolder,
  artistInfo,
  file
) {
  const profileFolder =
    await ensureFolder(
      artistFolder,
      'profile'
    );

  for (
    const child of [
      ...(profileFolder.children ||
        []),
    ]
  ) {
    if (
      !child.directory
    ) {
      await child.delete(
        true
      );
    }
  }

  const extension =
    profileExtension(
      file.originalname,
      file.mimetype
    );

  const uploaded =
    await uploadTempFileToMega(
      profileFolder,
      file,
      `profile-picture${extension}`
    );

  return {
    ...artistInfo,

    profilePicture:
      megaFileMetadata(
        uploaded,
        file.originalname,
        file.mimetype
      ),

    updatedAt:
      new Date().toISOString(),
  };
}

async function uploadTempFileToMega(
  folder,
  file,
  targetName
) {
  const stream =
    fs.createReadStream(
      file.path
    );

  try {
    const uploadStream =
      folder.upload(
        {
          name:
            targetName,

          size:
            file.size,
        },
        stream
      );

    return await uploadStream.complete;
  } finally {
    stream.destroy();
  }
}

async function writeJsonFile(
  folder,
  filename,
  data
) {
  const existing =
    findChild(
      folder,
      filename,
      false
    );

  if (existing) {
    await existing.delete(
      true
    );
  }

  const json =
    `${JSON.stringify(
      data,
      null,
      2
    )}\n`;

  return await folder.upload(
    {
      name:
        filename,

      size:
        Buffer.byteLength(
          json
        ),
    },

    Buffer.from(
      json,
      'utf8'
    )
  ).complete;
}

async function readJsonFile(
  folder,
  filename
) {
  const file =
    findChild(
      folder,
      filename,
      false
    );

  if (!file) {
    return null;
  }

  const buffer =
    await file.downloadBuffer();

  try {
    return JSON.parse(
      buffer.toString(
        'utf8'
      )
    );
  } catch {
    return null;
  }
}

async function findRegistration(
  registrationId
) {
  const id =
    String(
      registrationId ||
        ''
    ).trim();

  for (
    const root of [
      megaRoots.registeredRoot,
      megaRoots.approvedRoot,
    ]
  ) {
    for (
      const batchFolder of
      root.children ||
      []
    ) {
      if (
        !batchFolder.directory
      ) {
        continue;
      }

      for (
        const artistFolder of
        batchFolder.children ||
        []
      ) {
        if (
          !artistFolder.directory
        ) {
          continue;
        }

        const folder =
          findChild(
            artistFolder,
            id,
            true
          );

        if (!folder) {
          continue;
        }

        const registration =
          await readJsonFile(
            folder,
            'artwork-info.json'
          );

        if (
          registration
        ) {
          return {
            folder,
            registration,
          };
        }
      }
    }
  }

  return null;
}

async function listRegistrationsFromRoot(
  root,
  defaultStatus
) {
  const output = [];

  for (
    const batchFolder of
    root.children ||
    []
  ) {
    if (
      !batchFolder.directory
    ) {
      continue;
    }

    for (
      const artistFolder of
      batchFolder.children ||
      []
    ) {
      if (
        !artistFolder.directory
      ) {
        continue;
      }

      const artistInfo =
        await getArtistInfo(
          artistFolder.name
        );

      for (
        const registrationFolder of
        artistFolder.children ||
        []
      ) {
        if (
          !registrationFolder.directory
        ) {
          continue;
        }

        const registration =
          await readJsonFile(
            registrationFolder,
            'artwork-info.json'
          );

        if (!registration) {
          continue;
        }

        output.push(
          hydrateRegistration(
            {
              ...registration,

              status:
                registration.status ||
                defaultStatus,
            },

            artistInfo
          )
        );
      }
    }
  }

  return output;
}

async function deleteArtworkFiles(
  folder,
  files
) {
  for (
    const fileInfo of
    files ||
    []
  ) {
    const megaFile =
      mega.files?.[
        fileInfo.nodeId
      ];

    if (megaFile) {
      await megaFile.delete(
        true
      );

      continue;
    }

    const byName =
      findChild(
        folder,
        fileInfo.storedName,
        false
      );

    if (byName) {
      await byName.delete(
        true
      );
    }
  }
}

function getMegaNodeId(
  file
) {
  const match =
    Object.entries(
      mega?.files ||
        {}
    ).find(
      ([, candidate]) =>
        candidate ===
        file
    );

  return match?.[0] ||
    '';
}

function megaFileMetadata(
  file,
  originalName,
  mimeType
) {
  const nodeId =
    getMegaNodeId(file);

  return {
    nodeId,

    originalName:
      originalName ||
      file.name,

    storedName:
      file.name,

    mimeType:
      mimeType ||
      mimeTypeFromName(
        file.name
      ),

    size:
      Number(
        file.size ||
          0
      ),

    url:
      nodeId
        ? `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(
            nodeId
          )}`
        : '',
  };
}

function hydrateArtistInfo(
  artistInfo
) {
  if (!artistInfo) {
    return null;
  }

  return {
    ...artistInfo,

    profilePicture:
      hydrateFileMetadata(
        artistInfo.profilePicture
      ),
  };
}

function hydrateRegistration(
  registration,
  artistInfo
) {
  return {
    ...registration,

    student: {
      ...(registration.student ||
        {}),

      fullName:
        artistInfo?.fullName ||
        registration.student
          ?.fullName ||
        '',

      studentYear:
        artistInfo?.batch ||
        registration.student
          ?.studentYear ||
        '',

      profilePicture:
        hydrateFileMetadata(
          artistInfo
            ?.profilePicture ||
            registration.student
              ?.profilePicture ||
            null
        ),
    },

    files:
      (
        registration.files ||
        []
      ).map(
        hydrateFileMetadata
      ),
  };
}

function hydrateFileMetadata(
  file
) {
  if (!file) {
    return null;
  }

  return {
    ...file,

    url:
      file.nodeId
        ? `${PUBLIC_BASE_URL}/api/media/${encodeURIComponent(
            file.nodeId
          )}`
        : file.url ||
          '',
  };
}

function validateArtistFields(
  body
) {
  const required = [
    [
      'fullName',
      'Artist full name',
    ],
    [
      'studentYear',
      'Batch',
    ],
    [
      'artworkTitle',
      'Artwork title',
    ],
    [
      'category',
      'Category',
    ],
    [
      'medium',
      'Medium',
    ],
  ];

  for (
    const [
      key,
      label,
    ] of required
  ) {
    if (
      !String(
        body?.[key] ||
          ''
      ).trim()
    ) {
      throw new Error(
        `${label} is required.`
      );
    }
  }
}

function normalizeBatch(
  value
) {
  const text =
    String(
      value ||
        ''
    ).trim();

  const match =
    text.match(
      /202[0-5]/
    );

  if (match) {
    return `${match[0]} Batch`;
  }

  const direct =
    BATCH_FOLDERS.find(
      (batch) =>
        batch.toLowerCase() ===
        text.toLowerCase()
    );

  return direct ||
    text;
}

function normalizeIdentityName(
  value
) {
  return String(
    value ||
      ''
  )
    .normalize('NFKC')
    .trim()
    .replace(
      /\s+/g,
      ' '
    )
    .toLowerCase();
}

async function createRegistrationId() {
  for (
    let attempt = 0;
    attempt < 20;
    attempt += 1
  ) {
    const id =
      `ART-${new Date().getFullYear()}-${crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()}`;

    const existing =
      await findRegistration(
        id
      );

    if (!existing) {
      return id;
    }
  }

  return `ART-${new Date().getFullYear()}-${crypto.randomUUID()}`;
}

function buildArtworkFilename(
  originalName,
  index
) {
  const ext =
    path
      .extname(
        originalName
      )
      .toLowerCase();

  const base =
    safeFilename(
      path.basename(
        originalName,
        ext
      ),

      `artwork-${index}`
    ).slice(
      0,
      90
    );

  return `${String(
    index
  ).padStart(
    2,
    '0'
  )}-${base}${ext}`;
}

function safeFilename(
  value,
  fallback = 'file'
) {
  const cleaned =
    String(
      value ||
        ''
    )
      .normalize(
        'NFKD'
      )
      .replace(
        /[\u0300-\u036f]/g,
        ''
      )
      .replace(
        /[<>:"/\\|?*\x00-\x1f]+/g,
        '-'
      )
      .replace(
        /\s+/g,
        ' '
      )
      .replace(
        /^[-.\s]+|[-.\s]+$/g,
        ''
      )
      .trim();

  return cleaned ||
    fallback;
}

function profileExtension(
  originalName,
  mimeType
) {
  const ext =
    path
      .extname(
        originalName
      )
      .toLowerCase();

  if (
    [
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
    ].includes(
      ext
    )
  ) {
    return ext;
  }

  if (
    mimeType ===
    'image/png'
  ) {
    return '.png';
  }

  if (
    mimeType ===
    'image/webp'
  ) {
    return '.webp';
  }

  return '.jpg';
}

function mimeTypeFromName(
  filename
) {
  const ext =
    path
      .extname(
        String(
          filename ||
            ''
        )
      )
      .toLowerCase();

  if (
    ext ===
      '.jpg' ||
    ext ===
      '.jpeg'
  ) {
    return 'image/jpeg';
  }

  if (
    ext ===
    '.png'
  ) {
    return 'image/png';
  }

  if (
    ext ===
    '.webp'
  ) {
    return 'image/webp';
  }

  if (
    ext ===
    '.pdf'
  ) {
    return 'application/pdf';
  }

  return 'application/octet-stream';
}

function flattenIncomingFiles(
  files
) {
  if (!files) {
    return [];
  }

  if (
    Array.isArray(files)
  ) {
    return files;
  }

  return Object.values(
    files
  )
    .flat()
    .filter(Boolean);
}

async function cleanupIncoming(
  files
) {
  await Promise.all(
    (
      files ||
      []
    ).map(
      async (file) => {
        if (
          !file?.path
        ) {
          return;
        }

        try {
          await fsp.unlink(
            file.path
          );
        } catch (
          error
        ) {
          if (
            error.code !==
            'ENOENT'
          ) {
            console.warn(
              'Temporary file cleanup failed:',
              error.message
            );
          }
        }
      }
    )
  );
}

function bodyValue(
  body,
  key,
  fallback
) {
  if (
    !Object.prototype.hasOwnProperty.call(
      body ||
        {},
      key
    )
  ) {
    return fallback;
  }

  return String(
    body[key] ??
      ''
  ).trim();
}

function normalizeReviewStatus(
  value
) {
  const text =
    String(
      value ||
        ''
    )
      .trim()
      .toLowerCase();

  if (
    text ===
      'approved' ||
    text ===
      'approve'
  ) {
    return 'Approved';
  }

  if (
    text ===
      'rejected' ||
    text ===
      'reject'
  ) {
    return 'Rejected';
  }

  if (
    text ===
    'pending'
  ) {
    return 'Pending';
  }

  return '';
}

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      'Request error:',
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        error:
          error.message,

        field:
          error.field ||
          null,
      });
    }

    res.status(400).json({
      error:
        error.message ||
        'Bad request.',
    });
  }
);

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Fine Arts Exhibition API running on port ${PORT}`
    );

    console.log(
      'Permanent storage: MEGA only'
    );

    console.log(
      `MEGA folder: ${MEGA_ROOT_FOLDER}`
    );
  }
);
