/**
 * Cloudflare Worker for Fine Arts Exhibition
 * Handles:
 * - POST /api/presign-upload - Get presigned upload URL for artwork
 * - GET /api/artworks - List all approved artworks for public gallery
 * - POST /api/artworks - Admin creates/updates artwork metadata
 * - DELETE /api/artworks/:id - Admin deletes artwork
 */

import { isValidArtworkType } from './utils';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /api/presign-upload - Get presigned URL for direct browser upload
      if (path === '/api/presign-upload' && request.method === 'POST') {
        return await handlePresignUpload(request, env, corsHeaders);
      }

      // GET /api/artworks - Public gallery listing
      if (path === '/api/artworks' && request.method === 'GET') {
        return await handleListArtworks(request, env, corsHeaders);
      }

      // GET /api/artworks/:id - Single artwork details
      if (path.match(/^\/api\/artworks\/[^/]+$/) && request.method === 'GET') {
        const id = path.split('/').pop();
        return await handleGetArtwork(id, env, corsHeaders);
      }

      // POST /api/artworks - Admin creates artwork metadata after upload
      if (path === '/api/artworks' && request.method === 'POST') {
        return await handleCreateArtwork(request, env, corsHeaders);
      }

      // PUT /api/artworks/:id - Admin updates artwork (approve/reject)
      if (path.match(/^\/api\/artworks\/[^/]+$/) && request.method === 'PUT') {
        const id = path.split('/').pop();
        return await handleUpdateArtwork(id, request, env, corsHeaders);
      }

      // DELETE /api/artworks/:id - Admin deletes artwork
      if (path.match(/^\/api\/artworks\/[^/]+$/) && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return await handleDeleteArtwork(id, env, corsHeaders);
      }

      // POST /api/admin/login - Admin authentication
      if (path === '/api/admin/login' && request.method === 'POST') {
        return await handleAdminLogin(request, env, corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handlePresignUpload(request, env, corsHeaders) {
  const body = await request.json();
  const { filename, contentType, studentId } = body;

  if (!filename || !contentType) {
    return new Response(JSON.stringify({ error: 'Missing filename or contentType' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!allowedTypes.includes(contentType)) {
    return new Response(JSON.stringify({ error: 'File type not allowed' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Generate unique key: studentId/timestamp-filename
  const timestamp = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `uploads/${studentId || 'anonymous'}/${timestamp}-${safeFilename}`;

  // Generate presigned PUT URL (valid for 1 hour)
  const r2 = env.EXHIBITION_BUCKET;
  const presignedUrl = await r2.createPresignedUrl('PUT', key, {
    expiresIn: 3600,
    httpMetadata: {
      contentType: contentType,
    },
  });

  return new Response(JSON.stringify({
    uploadUrl: presignedUrl,
    key: key,
    publicUrl: `https://${new URL(presignedUrl).hostname}/${key}`,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleListArtworks(request, env, corsHeaders) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'approved';
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const offset = parseInt(url.searchParams.get('offset')) || 0;

  // List objects from R2
  const r2 = env.EXHIBITION_BUCKET;
  const listed = await r2.list({ prefix: 'artworks/', limit: limit + offset });

  const artworks = [];
  for (const object of listed.objects.slice(offset, offset + limit)) {
    // Try to get metadata from a separate metadata object
    const metaKey = object.key.replace('artworks/', 'metadata/') + '.json';
    try {
      const metaObj = await r2.get(metaKey);
      if (metaObj) {
        const metadata = await metaObj.json();
        if (!status || metadata.status === status) {
          artworks.push({
            id: object.key.replace('artworks/', ''),
            ...metadata,
            imageUrl: `https://${new URL(request.url).hostname}/${object.key}`,
            thumbnailUrl: `https://${new URL(request.url).hostname}/${object.key}`,
          });
        }
      }
    } catch (e) {
      // If no metadata, create basic entry
      const filename = object.key.split('/').pop();
      artworks.push({
        id: object.key.replace('artworks/', ''),
        title: filename,
        status: 'approved',
        imageUrl: `https://${new URL(request.url).hostname}/${object.key}`,
        thumbnailUrl: `https://${new URL(request.url).hostname}/${object.key}`,
      });
    }
  }

  return new Response(JSON.stringify({
    artworks,
    total: artworks.length,
    hasMore: listed.truncated,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleGetArtwork(id, env, corsHeaders) {
  const r2 = env.EXHIBITION_BUCKET;
  const metaKey = `metadata/artworks/${id}.json`;
  const metaObj = await r2.get(metaKey);

  if (!metaObj) {
    return new Response(JSON.stringify({ error: 'Artwork not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const metadata = await metaObj.json();
  return new Response(JSON.stringify({
    id,
    ...metadata,
    imageUrl: `https://${new URL('https://example.com').hostname}/artworks/${id}`,
    thumbnailUrl: `https://${new URL('https://example.com').hostname}/artworks/${id}`,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleCreateArtwork(request, env, corsHeaders) {
  const body = await request.json();
  const { key, title, category, medium, dimensions, description, studentName, studentRoll, studentYear } = body;

  if (!key || !title) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const r2 = env.EXHIBITION_BUCKET;
  
  // Copy from uploads/ to artworks/ with new name
  const artworkId = `${Date.now()}-${title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  const newKey = `artworks/${artworkId}`;
  
  const sourceObj = await r2.get(key);
  if (!sourceObj) {
    return new Response(JSON.stringify({ error: 'Source file not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Copy to artworks/
  await r2.put(newKey, sourceObj.body, {
    httpMetadata: sourceObj.httpMetadata,
  });

  // Store metadata
  const metadata = {
    title,
    category,
    medium,
    dimensions,
    description,
    studentName,
    studentRoll,
    studentYear,
    status: 'pending',
    uploadedAt: new Date().toISOString(),
    originalKey: key,
  };

  await r2.put(`metadata/${newKey}.json`, JSON.stringify(metadata));

  // Delete from uploads/
  await r2.delete(key);
  const uploadMetaKey = `metadata/${key}.json`;
  await r2.delete(uploadMetaKey).catch(() => {});

  return new Response(JSON.stringify({
    id: artworkId,
    ...metadata,
    imageUrl: `https://${new URL(request.url).hostname}/${newKey}`,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleUpdateArtwork(id, request, env, corsHeaders) {
  const body = await request.json();
  const r2 = env.EXHIBITION_BUCKET;
  const metaKey = `metadata/artworks/${id}.json`;
  
  const metaObj = await r2.get(metaKey);
  if (!metaObj) {
    return new Response(JSON.stringify({ error: 'Artwork not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const metadata = await metaObj.json();
  const updated = { ...metadata, ...body, updatedAt: new Date().toISOString() };
  
  await r2.put(metaKey, JSON.stringify(updated));

  return new Response(JSON.stringify({ id, ...updated }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleDeleteArtwork(id, env, corsHeaders) {
  const r2 = env.EXHIBITION_BUCKET;
  const artworkKey = `artworks/${id}`;
  const metaKey = `metadata/artworks/${id}.json`;

  await r2.delete(artworkKey);
  await r2.delete(metaKey);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleAdminLogin(request, env, corsHeaders) {
  const body = await request.json();
  const { password } = body;

  // In production, use proper password hashing and env var
  const adminPassword = env.ADMIN_PASSWORD || 'admin123';
  
  if (password === adminPassword) {
    return new Response(JSON.stringify({ 
      success: true, 
      token: 'admin-token-' + Date.now() 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid password' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}