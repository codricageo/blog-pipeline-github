// POST /posts  — rută PROTEJATĂ (cere Authorization: Bearer <IdToken>)
//
// Permisiune IAM: doar `dynamodb:PutItem` pe tabelul de postări.
// Nu poate citi, nu poate șterge. Least privilege.

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID } from 'node:crypto';
import { ddb, TABLE_NAME } from './lib/ddb.mjs';
import { json, error, parseBody, getUser } from './lib/http.mjs';

const sns = new SNSClient({});
const TOPIC_ARN = process.env.TOPIC_ARN;

export const handler = async (event) => {
  // Identitatea vine din token, NU din body.
  const user = getUser(event);
  if (!user.sub) {
    // Nu ar trebui să se întâmple pe o rută protejată — dar apărăm oricum
    // (se întâmplă cu `sam local start-api`, care nu rulează authorizer-ul).
    return error(401, 'Neautentificat');
  }

  let body;
  try {
    body = parseBody(event);
  } catch {
    return error(400, 'Body invalid: se aștepta JSON');
  }

  const title = (body.title ?? '').trim();
  const content = (body.content ?? '').trim();
  if (!title || !content) {
    return error(400, 'Câmpurile `title` și `content` sunt obligatorii');
  }

  // Imagine opțională, urcată în prealabil prin POST /uploads.
  // Prefixul cu `sub` garantează că nu poți atașa imaginea altui utilizator.
  const imageKey = (body.imageKey ?? '').trim();
  if (imageKey && !imageKey.startsWith(`uploads/${user.sub}/`)) {
    return error(400, '`imageKey` nu îți aparține');
  }

  const post = {
    postId: randomUUID(),        // partition key — unic per postare
    title,
    content,
    ...(imageKey && { imageKey }),
    author: user.email,          // pentru afișare
    authorSub: user.sub,         // pentru verificarea proprietății la delete
    createdAt: new Date().toISOString(),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: post,
      // Garanție că nu suprascriem un item existent. Practic imposibil cu un
      // UUID v4, dar arată cum se face o scriere condiționată în DynamoDB.
      ConditionExpression: 'attribute_not_exists(postId)',
    })
  );

  // Fan-out prin SNS: UN publish, oricâți abonați (email, SQS, ...).
  // Postarea E salvată deja — un eșec de notificare nu trebuie să-i dea
  // utilizatorului un 500, doar îl loghează pentru CloudWatch.
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: `Postare nouă: ${title.slice(0, 80)}`,
        Message: JSON.stringify({
          postId: post.postId,
          title: post.title,
          author: post.author,
          createdAt: post.createdAt,
        }),
      })
    );
  } catch (err) {
    console.error('Publicarea în SNS a eșuat:', err);
  }

  return json(201, post);
};
