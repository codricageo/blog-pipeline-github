// Client DynamoDB partajat de toate cele 3 funcții Lambda.
//
// De ce e definit AICI, în afara handler-ului?
// Codul din afara funcției `handler` rulează o singură dată, la "cold start".
// Lambda păstrează containerul cald între invocări, deci clientul (și
// conexiunile lui HTTPS) se refolosesc => invocările următoare sunt mai rapide.
// Asta e un pattern clasic de optimizare Lambda, întrebat des la DVA-C02.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Clientul "low-level" vorbește limbajul nativ DynamoDB, cu tipuri explicite:
//   { title: { S: "Salut" }, views: { N: "5" } }
const client = new DynamoDBClient({});

// DocumentClient traduce automat între JS obișnuit și formatul de mai sus,
// deci noi scriem doar: { title: "Salut", views: 5 }
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // DynamoDB nu acceptă string-uri goale în chei; scoatem valorile undefined
    removeUndefinedValues: true,
  },
});

// Numele tabelului vine din variabila de mediu setată de SAM în template.yaml.
// Niciodată hardcodat: același cod merge în dev/prod, doar variabila diferă.
export const TABLE_NAME = process.env.TABLE_NAME;
