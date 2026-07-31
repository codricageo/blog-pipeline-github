// DELETE /posts/{postId}  — rută PROTEJATĂ
//
// Permisiune IAM: doar `dynamodb:DeleteItem`.
// Observă că NU are nevoie de `GetItem`: verificarea proprietății se face
// atomic, în aceeași operație, printr-un ConditionExpression.

import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './lib/ddb.mjs';
import { json, error, getUser } from './lib/http.mjs';

export const handler = async (event) => {
  const user = getUser(event);
  if (!user.sub) return error(401, 'Neautentificat');

  // `{postId}` din calea rutei ajunge în pathParameters.
  const postId = event.pathParameters?.postId;
  if (!postId) return error(400, 'Lipsește `postId` din URL');

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { postId }, // tabelul are doar partition key => cheia e completă
        // Două verificări într-o singură operație atomică:
        //   1. postarea există
        //   2. îi aparține celui care cere ștergerea
        // Dacă oricare pică, DynamoDB aruncă ConditionalCheckFailedException
        // și NU șterge nimic. Fără citire-apoi-scriere => fără race condition.
        ConditionExpression: 'attribute_exists(postId) AND authorSub = :me',
        ExpressionAttributeValues: { ':me': user.sub },
      })
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Nu spunem care dintre cele două condiții a picat: dacă am zice
      // "postarea nu e a ta", am confirma unui atacator că postarea există.
      return error(403, 'Postarea nu există sau nu îți aparține');
    }
    throw err; // orice altceva => 500, vizibil în CloudWatch Logs
  }

  return json(200, { message: 'Postare ștearsă', postId });
};
