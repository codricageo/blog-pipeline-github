# Blog serverless AWS — proiect de învățare (DVA-C02)

Blog minimal: oricine poate citi postările, doar utilizatorii autentificați pot crea
și șterge (și doar postările proprii).

## Serviciile folosite și de ce

| Serviciu | Rol în proiect | De ce el |
|---|---|---|
| **DynamoDB** | stochează postările | bază NoSQL serverless, scalează automat, plată la cerere; se potrivește cu Lambda, care poate porni sute de instanțe simultan (o bază SQL ar rămâne fără conexiuni) |
| **Lambda** | rulează codul (3 funcții) | fără servere de administrat, plătești doar milisecundele de execuție |
| **API Gateway (HTTP API)** | expune funcțiile pe internet | rutează HTTP → Lambda; validează token-ul JWT **înainte** de a chema codul tău. HTTP API e ~70% mai ieftin decât REST API |
| **Cognito User Pool** | conturi și login | emite tokenuri JWT semnate; nu scrii tu cod de parole/hashing |
| **S3 (imagini)** | stochează pozele postatărilor | upload direct din browser prin **presigned URL** — fișierul nu trece prin Lambda/API Gateway (limită ~6MB payload) |
| **S3 + CloudFront (site)** | găzduiește frontend-ul | bucket privat + **Origin Access Control**; CloudFront servește static cu HTTPS și cache global |
| **SNS** | anunță „postare nouă” | **fan-out**: un singur publish ajunge la toți abonații (email + coadă SQS) |
| **SQS** | decuplează procesarea | retry automat, **DLQ** după 3 eșecuri, absoarbe vârfurile de trafic |
| **CodePipeline + CodeBuild** | CI/CD | la fiecare push pe GitHub: `sam build` + `sam deploy` + publicare frontend, automat |
| **IAM** | permisiuni | fiecare Lambda primește un rol cu strict minimul necesar |
| **CloudFormation / SAM** | Infrastructure as Code | toată infrastructura într-un fișier versionabil; `sam delete` șterge tot |

## Arhitectură

```
Browser ──login──▶ Cognito User Pool ──IdToken (JWT)──▶ Browser
   │
   └──HTTP + Authorization: Bearer <IdToken>──▶ API Gateway (HTTP API)
                                                    │  ┌─ validează JWT
                                                    ▼  │
              ┌────────────────┬─────────────┴──┴───────────┬──────────────┐
   GET /posts (public) │ POST /posts │ DELETE /posts/{id} │ POST /uploads  │
              ▼        ▼             ▼                    ▼               │
         getPosts   createPost   deletePost         getUploadUrl          │
           │ ▲         │ │                             │                  │
           │ │ presign │ └─publish─▶ SNS topic         │ presigned PUT    │
           ▼ │  GET    ▼            │    │             ▼                  │
        DynamoDB ◀── PutItem     email  SQS ─▶ processPostEvent ─▶ DynamoDB (UpdateItem)
           ▲                                                              │
           │          S3 imagini ◀── browser PUT (presigned URL) ◀───────┘
           │               │
           │               └── ObjectCreated ─▶ SQS ─▶ processImageUpload (loguri)
           │
  Frontend: S3 (privat) ◀── OAC ── CloudFront ── HTTPS ──▶ vizitatori
```

## Structura fișierelor

```
├── template.yaml          # toată infrastructura aplicației (SAM/CloudFormation)
├── pipeline.yaml          # infrastructura CI/CD (se instalează separat, o dată)
├── buildspec.yml          # pașii rulați de CodeBuild la fiecare push
├── deploy.ps1             # deploy local: build + deploy + config.js + publicare site
├── src/                   # cod Lambda (CodeUri comun pentru toate funcțiile)
│   ├── package.json       # obligatoriu — `sam build` rulează npm install aici
│   ├── createPost.mjs     # POST   /posts        (+ publish SNS)
│   ├── getPosts.mjs       # GET    /posts        (+ presigned GET pt. imagini)
│   ├── deletePost.mjs     # DELETE /posts/{postId}
│   ├── getUploadUrl.mjs   # POST   /uploads      (presigned PUT către S3)
│   ├── processPostEvent.mjs   # consumator SQS (evenimente SNS „postare nouă”)
│   ├── processImageUpload.mjs # consumator SQS (evenimente S3 ObjectCreated)
│   └── lib/
│       ├── ddb.mjs        # client DynamoDB partajat
│       └── http.mjs       # helpere răspuns + citirea claim-urilor JWT
└── frontend/
    ├── index.html
    ├── app.js             # login/register Cognito + apeluri API + upload imagini
    └── config.js          # generat automat de deploy.ps1 după deploy
```

## Modelul de date DynamoDB

Tabel `<stack-name>-posts`, `BillingMode: PAY_PER_REQUEST`.

| Atribut | Tip | Rol |
|---|---|---|
| `postId` | S | **partition key** — UUID generat în Lambda |
| `title` | S | titlul |
| `content` | S | textul |
| `author` | S | email-ul din token (`claims.email`) — pentru afișare |
| `authorSub` | S | `claims.sub` — ID Cognito stabil, pentru verificarea proprietății |
| `createdAt` | S | ISO 8601 |

Fără sort key, fără GSI. În `AttributeDefinitions` apare **doar** `postId`: DynamoDB
declară exclusiv atributele-cheie, restul sunt schemaless.

## IAM — least privilege

| Funcție | Acțiune permisă | Resursă | De ce atât |
|---|---|---|---|
| `createPost` | `dynamodb:PutItem` | ARN-ul tabelului | doar scrie itemi noi; nu poate citi sau șterge nimic |
| `getPosts` | `dynamodb:Scan` | ARN-ul tabelului | doar citește; chiar dacă ar avea un bug, nu poate altera date |
| `deletePost` | `dynamodb:DeleteItem` | ARN-ul tabelului | nu are nevoie de `GetItem` — proprietatea se verifică prin `ConditionExpression` |

Nu folosim `DynamoDBCrudPolicy` (policy-ul gata făcut din SAM) fiindcă acordă
Put+Get+Update+Delete+Query+Scan+Batch\* pe tabel **și** pe indexuri — exact opusul
principiului. Permisiunile de CloudWatch Logs vin automat, din
`AWSLambdaBasicExecutionRole` pe care SAM îl atașează singur.

---

# Deploy

## 0. Cerințe

```powershell
aws --version    # AWS CLI v2, configurat cu `aws configure`
sam --version    # AWS SAM CLI
node --version   # v18+
```

## 1. Deploy automat

```powershell
.\deploy.ps1
```

Scriptul rulează `sam build`, apoi `sam deploy`, citește output-urile CloudFormation și actualizează automat `frontend/config.js` cu URL-ul API, ID-ul Cognito App Client și regiunea. Dacă stack-ul are și hosting (output-urile `SiteBucketName`/`SiteDistributionId`), scriptul sincronizează frontend-ul în S3 și invalidează cache-ul CloudFront — situl live e la output-ul `SiteUrl`.

> ⚠ Primul deploy cu CloudFront durează 5–10 minute (distribuția se propagă global). E normal.

Opțional, poți primi email la fiecare postare nouă (abonare SNS — primești un email de confirmare pe care trebuie să-l accepți):

```powershell
sam deploy --parameter-overrides NotificationEmail=eu@exemplu.com
```

La primul deploy, `sam deploy` va cere confirmări și va salva setările în `samconfig.toml`. Răspunsuri recomandate:

- *Stack Name*: `blog-serverless`
- *AWS Region*: `eu-central-1` (sau regiunea ta)
- *Confirm changes before deploy*: `y` — vezi change set-ul înainte să se aplice
- *Allow SAM CLI IAM role creation*: `y` (echivalentul lui `--capabilities CAPABILITY_IAM`)
- *Disable rollback*: `N`
- *Save arguments to configuration file*: `y`

Poți rula aceeași comandă la fiecare redeploy. Scriptul citește numele stack-ului și regiunea din `samconfig.toml`; le poți suprascrie când este necesar:

```powershell
.\deploy.ps1 -StackName alt-stack -Region eu-west-1
```

## 2. Consultă Outputs-urile pentru teste CLI

```powershell
aws cloudformation describe-stacks --stack-name blog-serverless `
  --query "Stacks[0].Outputs" --output table
```

Le pui în variabile pentru testele de mai jos:

```powershell
$API       = "https://xxxx.execute-api.eu-central-1.amazonaws.com/prod"
$POOL_ID   = "eu-central-1_xxxxxxxxx"
$CLIENT_ID = "xxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## 3. Creează un utilizator

Cognito nu are useri la început. Cel mai simplu, din CLI:

```powershell
aws cognito-idp admin-create-user `
  --user-pool-id $POOL_ID `
  --username eu@exemplu.com `
  --user-attributes Name=email,Value=eu@exemplu.com Name=email_verified,Value=true `
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password `
  --user-pool-id $POOL_ID `
  --username eu@exemplu.com `
  --password 'Parola123' `
  --permanent
```

`--message-action SUPPRESS` = nu trimite email de invitație.
`--user-attributes` cu `email` + `email_verified=true` este important: fără ele,
claim-ul `email` poate lipsi din IdToken, iar `author` ar ajunge `undefined`.
`--permanent` este **esențial**: fără el, userul rămâne în starea
`FORCE_CHANGE_PASSWORD`, iar login-ul returnează challenge-ul
`NEW_PASSWORD_REQUIRED` în loc de tokenuri.

---

# Testare — pas cu pas

## Test 1 — citirea e publică (fără token)

```powershell
curl.exe "$API/posts"
```
Așteptat: `200` cu `{"count":0,"posts":[]}`.

## Test 2 — scrierea fără token e respinsă

```powershell
curl.exe -i -X POST "$API/posts" `
  -H "Content-Type: application/json" `
  -d '{\"title\":\"test\",\"content\":\"test\"}'
```
Așteptat: **`401 Unauthorized`**, cu body `{"message":"Unauthorized"}`.
Răspunsul vine de la **API Gateway**, nu de la Lambda — funcția nici măcar nu
a fost invocată. Asta e ideea authorizer-ului: filtrezi înainte de a plăti execuția.

## Test 3 — login și obținerea token-ului

```powershell
$AUTH = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id $CLIENT_ID `
  --auth-parameters USERNAME=eu@exemplu.com,PASSWORD='Parola123' | ConvertFrom-Json

$TOKEN = $AUTH.AuthenticationResult.IdToken
```

Poți inspecta payload-ul token-ului (un JWT e doar base64, nu criptat) pe
<https://jwt.io> — vei vedea claim-urile `sub`, `email`, `aud`, `iss`, `exp`.

## Test 4 — creare cu token

```powershell
curl.exe -X POST "$API/posts" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{\"title\":\"Prima postare\",\"content\":\"Salut din Lambda!\"}'
```
Așteptat: `201` cu postarea creată, inclusiv `postId` și `author` completat automat
din token.

## Test 5 — verifică în DynamoDB

```powershell
aws dynamodb scan --table-name blog-serverless-posts
```
Vei vedea formatul nativ, cu tipuri explicite (`{"S": "..."}`) — exact ce ascunde
`DynamoDBDocumentClient` din cod.

## Test 6 — ștergere

```powershell
$POST_ID = "<postId din Test 4>"

curl.exe -X DELETE "$API/posts/$POST_ID" -H "Authorization: Bearer $TOKEN"
```
Așteptat: `200`. Rulează comanda a doua oară → **`403`**, fiindcă
`ConditionExpression` nu mai găsește itemul.

## Test 7 — frontend

Rulează `deploy.ps1`, apoi pornește serverul static:

```powershell
cd frontend
python -m http.server 8000
```
Deschide <http://localhost:8000>.

> ⚠ **Nu deschide `index.html` direct prin dublu-click.** Ca `file://`, browserul
> trimite `Origin: null` și toate cererile pică pe CORS. Trebuie servit pe
> `http://localhost:8000`, exact originea din parametrul `AllowedOrigin`.

## Loguri

```powershell
sam logs --stack-name blog-serverless --name CreatePostFunction --tail
```

---

# Note pentru examenul DVA-C02

- **`sam local start-api` NU aplică authorizer-ul JWT.** Local, rutele protejate par
  deschise, iar `event.requestContext.authorizer` e `undefined` — de aceea codul
  folosește `?.` peste tot. Autorizarea se testează doar deployat.
- **Scan vs Query.** `Query` cere o valoare exactă de partition key. Fiecare postare
  are alt `postId`, deci nu există partiție comună → rămâne `Scan`, care citește tot
  tabelul. Soluția de producție: un GSI cu partition key constant (`type = "POST"`) și
  sort key `createdAt`; listarea devine `Query`, dar fiecare scriere costă în plus,
  fiindcă se scrie și în index.
- **ID token vs Access token.** Ambele trec de authorizer-ul HTTP API (care validează
  `aud`, cu fallback pe `client_id`). Folosim ID token fiindcă doar el conține `email`.
  Atenție: un authorizer Cognito pe **REST API** acceptă *doar* ID token — diferență
  clasică de examen.
- **`ApiId: !Ref BlogApi` e obligatoriu** pe fiecare event `HttpApi`. Dacă îl omiți,
  SAM creează în tăcere un al doilea API implicit (`ServerlessHttpApi`), fără
  authorizer — o gaură de securitate greu de observat.
- **Cheile `issuer`/`audience` sunt cu literă mică** în `AWS::Serverless::HttpApi`.
  Cu majusculă merg doar pe resursa brută `AWS::ApiGatewayV2::Authorizer`.
- **`ConditionExpression`** rezolvă atomic „există?" + „e a mea?" într-o singură
  operație, fără citire-apoi-scriere → fără race condition și cu o permisiune IAM mai
  puțin.
- **Codul din afara `handler`** (clientul DynamoDB) rulează o singură dată, la cold
  start, și se refolosește între invocări.
- **Presigned URL-uri.** Upload/download direct în S3 fără a expune bucket-ul public:
  URL-ul poartă semnătura și permisiunile funcției care l-a generat, cu expirare.
  `ContentType` face parte din semnătură la PUT — nu poți urca alt tip de fișier.
- **SNS vs SQS.** SNS = push, fan-out 1→N, nu reține mesajele. SQS = pull, un singur
  consumator per mesaj, reține până la 14 zile. Pattern-ul clasic de examen:
  **SNS → mai multe cozi SQS** combină fan-out cu durabilitate și retry.
- **Partial batch failure.** Lambda cu event SQS + `ReportBatchItemFailures`:
  returnezi `{batchItemFailures: [{itemIdentifier: messageId}]}` și SQS reîncearcă
  DOAR mesajele eșuate, nu tot batch-ul. Fără asta, un mesaj stricat re-procesează
  întregul batch (posibile duplicate).
- **DLQ (dead-letter queue).** După `maxReceiveCount` eșecuri, mesajul se mută în DLQ
  pentru inspecție — altfel un mesaj „otrăvit” s-ar reprocesa la nesfârșit.
- **Visibility timeout ≥ timeout-ul funcției** (recomandat 6×): altfel mesajul
  redevine vizibil și e procesat în paralel de altă invocare.
- **OAC (Origin Access Control).** Bucket-ul sitului rămâne privat; doar CloudFront
  poate citi din el (bucket policy cu `AWS:SourceArn` = ARN-ul distribuției).
  Înlocuiește vechiul OAI — examenele noi întreabă de OAC.
- **Invalidare CloudFront.** Politica de cache CachingOptimized ignoră query
  string-urile, deci `config.js?v=2` NU ocolește cache-ul — după fiecare deploy se
  rulează `create-invalidation --paths "/*"`.
- **buildspec.yml** are faze fixe: `install`, `pre_build`, `build`, `post_build`.
  În CI folosești `sam deploy --no-confirm-changeset --no-fail-on-empty-changeset`.

# CI/CD — instalare (o singură dată)

1. Creează un repo GitHub și urcă proiectul:
   ```powershell
   git init; git add .; git commit -m "initial"
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
2. Instalează pipeline-ul (stack separat de aplicație):
   ```powershell
   aws cloudformation deploy `
     --template-file pipeline.yaml `
     --stack-name blog-pipeline `
     --capabilities CAPABILITY_IAM `
     --parameter-overrides GitHubRepo=<user>/<repo>
   ```
3. **Autorizează conexiunea GitHub** (pas manual obligatoriu): consola AWS →
   *Developer Tools → Settings → Connections* → conexiunea `blog-pipeline-github`
   (starea *Pending*) → *Update pending connection* → loghează-te cu GitHub.
4. De acum, fiecare `git push` pe `main` declanșează pipeline-ul: build → deploy →
   publicare frontend. Urmărește-l în consola CodePipeline.

# Curățenie

```powershell
# Bucket-urile S3 trebuie golite înainte — CloudFormation nu șterge bucket-uri pline:
aws s3 rm s3://blog-serveless-images --recursive
aws s3 rm s3://blog-serveless-site --recursive

sam delete --stack-name blog-serveless

# Pipeline-ul CI/CD (dacă l-ai instalat) e un stack separat:
aws cloudformation delete-stack --stack-name blog-pipeline
```
Șterge tot ce a creat stack-ul: tabel, funcții, API, user pool, topic SNS, cozi SQS,
distribuția CloudFront, roluri IAM.
