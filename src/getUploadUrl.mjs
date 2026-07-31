// POST /uploads  — rută PROTEJATĂ
//
// NU primește fișierul! Browserul cere doar un "presigned URL": un URL S3
// semnat cu permisiunile ACESTEI funcții, valabil câteva minute. Apoi urcă
// fișierul DIRECT în S3, fără să treacă prin Lambda/API Gateway (care oricum
// au limită de payload ~6MB/10MB). Pattern standard, întrebat la DVA-C02.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { json, error, parseBody, getUser } from './lib/http.mjs';

const s3 = new S3Client({});
const BUCKET = process.env.IMAGES_BUCKET;

// Doar imagini. Extensia derivă din content-type, nu din numele fișierului
// trimis de client (care poate minți).
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const URL_TTL_SECONDS = 300; // 5 minute; după expirare S3 răspunde 403

export const handler = async (event) => {
  const user = getUser(event);
  if (!user.sub) return error(401, 'Neautentificat');

  let body;
  try {
    body = parseBody(event);
  } catch {
    return error(400, 'Body invalid: se aștepta JSON');
  }

  const contentType = (body.contentType ?? '').toLowerCase();
  const extension = ALLOWED_TYPES[contentType];
  if (!extension) {
    return error(400, `Tip de fișier nepermis. Acceptate: ${Object.keys(ALLOWED_TYPES).join(', ')}`);
  }

  // Cheia include `sub`-ul: la createPost verificăm că imaginea atașată
  // aparține chiar utilizatorului care postează.
  const imageKey = `uploads/${user.sub}/${randomUUID()}.${extension}`;

  // ContentType face parte din semnătură: URL-ul semnat pentru image/png
  // nu poate fi folosit ca să urci altceva.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: imageKey, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS }
  );

  return json(200, { uploadUrl, imageKey, expiresIn: URL_TTL_SECONDS });
};
