// GET /posts  — rută PUBLICĂ (fără token)
//
// Permisiune IAM: doar `dynamodb:Scan`. Funcția asta nu poate scrie nimic,
// deci chiar dacă ar avea un bug exploatabil, nu poate strica datele.

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE_NAME } from './lib/ddb.mjs';
import { json } from './lib/http.mjs';

const s3 = new S3Client({});
const IMAGES_BUCKET = process.env.IMAGES_BUCKET;

export const handler = async () => {
  // DE CE Scan și nu Query?
  //   `Query` cere o valoare exactă de partition key ("dă-mi postarea X").
  //   Noi vrem TOATE postările, iar fiecare are alt `postId` => nu există o
  //   partiție comună pe care să interoghezi. Rămâne `Scan`.
  //
  // Costul: Scan citește tot tabelul și consumă RCU proporțional cu mărimea.
  // OK pentru zeci de postări, prost la scară.
  //
  // Cum s-ar rezolva în producție: un GSI cu partition key constant
  // (ex. type = "POST") și sort key `createdAt`. Atunci listarea devine un
  // `Query` care citește doar ce afișezi, deja sortat. Prețul: fiecare scriere
  // costă în plus, fiindcă se scrie și în index.
  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 50, // limităm rezultatele; vezi nota despre paginare mai jos
    })
  );

  // Notă despre paginare: un Scan returnează maximum 1 MB per apel. Dacă mai
  // sunt date, răspunsul conține `LastEvaluatedKey`, pe care l-ai trimite ca
  // `ExclusiveStartKey` la apelul următor. Aici ignorăm asta intenționat.
  const posts = (result.Items ?? []).sort((a, b) =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '') // cele mai noi primele
  );

  // Nu expunem `authorSub` (ID-ul intern Cognito) către frontend-ul public.
  // Pentru postările cu imagine generăm un presigned GET URL: bucketul e
  // privat, deci browserul poate citi imaginea DOAR printr-un URL semnat.
  const publicPosts = await Promise.all(
    posts.map(async ({ authorSub, imageKey, ...rest }) => {
      if (!imageKey) return rest;
      const imageUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: imageKey }),
        { expiresIn: 3600 } // 1h; suficient pentru o sesiune de citire
      );
      return { ...rest, imageUrl };
    })
  );

  return json(200, { count: publicPosts.length, posts: publicPosts });
};
