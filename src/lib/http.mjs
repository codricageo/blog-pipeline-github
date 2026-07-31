// Helpere pentru răspunsurile HTTP API (payload format 2.0).
//
// API Gateway HTTP API așteaptă de la Lambda un obiect cu forma:
//   { statusCode, headers, body }   — unde `body` e ÎNTOTDEAUNA un string.

/** Răspuns JSON standard. */
export function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

/** Răspuns de eroare, cu același format ca `json`. */
export function error(statusCode, message) {
  return json(statusCode, { message });
}

/**
 * Citește și parsează body-ul cererii.
 * `event.body` e un string; poate fi base64 dacă `isBase64Encoded` e true
 * (se întâmplă la conținut binar) — de aceea decodăm defensiv.
 */
export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(raw);
}

/**
 * Extrage identitatea utilizatorului din token-ul JWT validat de authorizer.
 *
 * IMPORTANT (securitate): API Gateway a verificat deja semnătura, expirarea și
 * `aud`/`iss` ale token-ului ÎNAINTE să ne cheme. Dacă cererea a ajuns aici pe
 * o rută protejată, claim-urile sunt de încredere. De aceea NU luăm niciodată
 * autorul din body-ul cererii — oricine ar putea scrie acolo ce vrea.
 *
 * `?.` peste tot fiindcă `sam local start-api` NU aplică authorizer-ul:
 * local, `requestContext.authorizer` este undefined.
 */
export function getUser(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  return {
    // `sub` = ID-ul intern, stabil și imuabil al userului în Cognito.
    // Îl folosim pentru verificarea proprietății (poate schimba email-ul).
    sub: claims.sub,
    // `email` = pentru afișare. Atenție: `cognito:username` NU e email-ul,
    // e un UUID, fiindcă pool-ul e configurat cu UsernameAttributes: [email].
    email: claims.email,
  };
}
