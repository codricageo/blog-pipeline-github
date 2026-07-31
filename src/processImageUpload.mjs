// Consumator SQS — evenimente S3 "ObjectCreated" pentru uploads/ (imagini).
//
// Lanțul: browser PUT (presigned) → S3 → notificare → SQS → funcția de față.
// De ce prin coadă și nu S3→Lambda direct? Retry + DLQ gratuite, absorbția
// vârfurilor și decuplarea de producător. Aici doar citim metadatele
// obiectului și le logăm — punct de plecare pentru procesări reale
// (redimensionare, moderare, thumbnails).

import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      // Body-ul SQS conține evenimentul S3, care are propriul array Records.
      const s3Event = JSON.parse(record.body);

      // S3 trimite și un eveniment de test "s3:TestEvent" la configurare.
      if (!Array.isArray(s3Event.Records)) continue;

      for (const s3Record of s3Event.Records) {
        const bucket = s3Record.s3.bucket.name;
        // Cheia vine URL-encoded (spațiile devin "+").
        const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        console.log('Imagine urcată:', {
          key,
          size: head.ContentLength,
          contentType: head.ContentType,
          uploadedAt: head.LastModified,
        });
      }
    } catch (err) {
      console.error(`Eșec la mesajul ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
