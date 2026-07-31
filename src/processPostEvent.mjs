// Consumator SQS — evenimente de postare nouă (venite prin SNS fan-out).
//
// Lanțul: createPost → SNS topic → (email + coada asta) → funcția de față.
// Demonstrează consumul în batch și "partial batch failure": dacă un mesaj
// pică, îl raportăm individual în `batchItemFailures` — SQS reîncearcă DOAR
// mesajul acela, nu tot batch-ul. După 3 eșecuri ajunge în DLQ.

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './lib/ddb.mjs';

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      // RawMessageDelivery: true => body-ul e direct JSON-ul publicat de noi.
      const message = JSON.parse(record.body);
      if (!message.postId) throw new Error('Mesaj fără postId');

      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { postId: message.postId },
          UpdateExpression: 'SET notifiedAt = :now',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
          // Nu recreăm postarea dacă a fost ștearsă între timp.
          ConditionExpression: 'attribute_exists(postId)',
        })
      );
      console.log(`Postare procesată: ${message.postId}`);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Postarea nu mai există — nu e o eroare de reîncercat.
        console.warn(`Postarea din mesajul ${record.messageId} nu mai există`);
        continue;
      }
      console.error(`Eșec la mesajul ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
