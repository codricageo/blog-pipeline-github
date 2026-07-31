# Faza Deploy — cum urci și cum ștergi stack-ul, pas cu pas

Proiectul are **două stack-uri** separate:

| Stack | Ce conține | Cum se instalează |
|---|---|---|
| `blog-serveless` | aplicația: Lambda, DynamoDB, Cognito, API Gateway, S3, SNS, SQS, CloudFront | automat, prin pipeline (sau local cu `deploy.ps1`) |
| `blog-pipeline` | CI/CD: conexiunea GitHub, CodePipeline, CodeBuild, bucket artefacte | manual, o singură dată |

Mai apare și un al treilea, creat automat de SAM: `aws-sam-cli-managed-default`
(bucket-ul în care SAM urcă pachetele Lambda). Nu îl instalezi tu — vezi secțiunea
de ștergere.

---

## A. DEPLOY

### Varianta 1 — prin CI/CD (recomandată)

#### Pasul 1: pipeline-ul există deja?

```powershell
aws codepipeline get-pipeline-state --name blog-pipeline-pipeline --region eu-central-1
```

- **Dacă răspunde cu detalii** → pipeline-ul există. Sari direct la Pasul 4.
- **Dacă dă eroare** → instalează-l (Pașii 2–3).

#### Pasul 2: instalează stack-ul pipeline (o singură dată)

```powershell
aws cloudformation deploy `
  --template-file pipeline.yaml `
  --stack-name blog-pipeline `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides GitHubRepo=codricageo/blog-pipeline-github `
  --region eu-central-1
```

#### Pasul 3: autorizează conexiunea GitHub (pas manual OBLIGATORIU)

Conexiunea nou-creată e în starea **Pending** — fără autorizare, pipeline-ul pică la
etapa Source.

1. Deschide: <https://eu-central-1.console.aws.amazon.com/codesuite/settings/connections?region=eu-central-1>
2. Selectează conexiunea `blog-pipeline-github` (starea *Pending*)
3. **Update pending connection** → loghează-te cu GitHub → **Connect**
4. Starea devine **Available**

#### Pasul 4: declanșează deploy-ul

Orice push pe `main` pornește automat pipeline-ul:

```powershell
git add .
git commit -m "mesajul tau"
git push
```

Sau, fără nicio modificare de cod, pornește-l manual:

```powershell
aws codepipeline start-pipeline-execution --name blog-pipeline-pipeline --region eu-central-1
```

#### Pasul 5: urmărește execuția

```powershell
aws codepipeline get-pipeline-state --name blog-pipeline-pipeline --region eu-central-1 `
  --query "stageStates[].{Stage:stageName,Status:latestExecution.status}" --output table
```

- `Source: Succeeded` → codul a fost citit din GitHub
- `Build: InProgress` → rulează `sam build` + `sam deploy` + publicarea sitului
- **Primul deploy durează 10–15 minute** (CloudFront se propagă global). E normal.
- Dacă `Build: Failed` → vezi logurile în consola CodeBuild, proiectul `blog-pipeline-build`.

Ce face pipeline-ul în spate (definit în `buildspec.yml`):
1. `sam build` — bundling esbuild: fiecare funcție devine un singur fișier JS
2. `sam deploy --no-confirm-changeset --no-fail-on-empty-changeset` — creează/actualizează `blog-serveless`
3. citește output-urile CloudFormation și generează `frontend/config.js`
4. `aws s3 sync frontend/ s3://blog-serveless-site --delete`
5. invalidare CloudFront (`--paths "/*"`) ca vizitatorii să vadă imediat versiunea nouă

#### Pasul 6: verifică rezultatul

```powershell
# adresa publică a sitului + API
aws cloudformation describe-stacks --stack-name blog-serveless --region eu-central-1 `
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl' || OutputKey=='ApiUrl'].{Key:OutputKey,Value:OutputValue}" --output table

# smoke test API (trebuie să răspundă 200 cu JSON)
curl.exe -s "<ApiUrl>/posts"
```

Deschide `SiteUrl` în browser: înregistrare cont → cod pe email → login → postare cu imagine.

### Varianta 2 — local, cu deploy.ps1 (alternativă)

```powershell
.\deploy.ps1
```

Face aceiași pași ca pipeline-ul, dar de pe calculatorul tău.

> ⚠ Pe Windows, `sam build` poate pica cu `[WinError 3]` din cauza limitei de
> 260 de caractere la căi. Bundling-ul esbuild (deja configurat în `template.yaml`)
> rezolvă problema — dacă apare totuși, șterge `.aws-sam/` și reîncearcă.

---

## B. ȘTERGERE (curățenie completă)

Ordinea contează: întâi golești bucket-urile, apoi ștergi stack-urile.
CloudFormation **refuză** să șteargă bucket-uri S3 care nu sunt goale.

### Pasul 1: șterge stack-ul aplicației

```powershell
# golește bucket-urile aplicației
aws s3 rm s3://blog-serveless-images --recursive
aws s3 rm s3://blog-serveless-site --recursive

# șterge stack-ul (cere confirmare cu y)
sam delete --stack-name blog-serveless --region eu-central-1
```

Șterge: tabelul DynamoDB (**cu toate postările!**), funcțiile Lambda, API-ul,
User Pool-ul Cognito (**cu toți userii!**), topicul SNS, cozile SQS, distribuția
CloudFront (durează câteva minute) și rolurile IAM.

### Pasul 2 (opțional): șterge pipeline-ul CI/CD

> 💡 Recomandare: **păstrează-l**. Costă ~0 în repaus, iar redeployul în altă zi
> devine un singur `git push`. Dacă îl ștergi, data viitoare reinstalezi
> `pipeline.yaml` ȘI re-autorizezi manual conexiunea GitHub (Pașii A.2–A.3).

```powershell
# golește bucket-ul de artefacte (înlocuiește ID-ul de cont dacă diferă)
aws s3 rm s3://blog-pipeline-artifacts-363934055577 --recursive

aws cloudformation delete-stack --stack-name blog-pipeline --region eu-central-1
```

### Pasul 3 (opțional): șterge stack-ul gestionat de SAM

`aws-sam-cli-managed-default` conține bucket-ul de pachete al lui SAM. Bucket-ul e
**versionat**, deci trebuie șterse și versiunile obiectelor:

```powershell
# 1. află numele bucket-ului
$BUCKET = aws cloudformation describe-stack-resources `
  --stack-name aws-sam-cli-managed-default --region eu-central-1 `
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text

# 2. șterge toate versiunile obiectelor
$versions = aws s3api list-object-versions --bucket $BUCKET --region eu-central-1 `
  --query "{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }" `
  --output json
if ($versions -and ($versions | ConvertFrom-Json).Objects) {
  $versions | Set-Content -Encoding utf8 delete.json
  aws s3api delete-objects --bucket $BUCKET --region eu-central-1 --delete file://delete.json
  Remove-Item delete.json
}

# 3. șterge stack-ul
aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default --region eu-central-1
```

Alternativă din consolă: S3 → bucket-ul `aws-sam-cli-managed-default-samclisourcebucket-...`
→ **Empty** (șterge și versiunile) → CloudFormation → stack → **Delete**.

Notă: la următorul deploy, SAM recreează acest stack automat — e comportament
normal, nu o resursă uitată.

### Pasul 4: verificarea finală

```powershell
aws cloudformation list-stacks --region eu-central-1 `
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED `
  --query "StackSummaries[].StackName" --output table
```

Lista trebuie să fie goală (sau să conțină doar `blog-pipeline`, dacă l-ai păstrat).
`DELETE_FAILED` = aproape sigur un bucket negolit → golește-l și rulează delete din nou.

---

## C. Ce pierzi / ce NU pierzi la ștergere

| Se pierde | NU se pierde |
|---|---|
| postările din DynamoDB | codul — e pe GitHub (`codricageo/blog-pipeline-github`) |
| pozele din S3 | configurația infrastructurii — e în `template.yaml` |
| userii din Cognito | pipeline-ul (dacă l-ai păstrat) |
| URL-urile (CloudFront/API primesc altele noi la recreare) | |

**Revenirea în altă zi:**

- Pipeline păstrat → un singur pas:
  ```powershell
  aws codepipeline start-pipeline-execution --name blog-pipeline-pipeline --region eu-central-1
  ```
- Pipeline șters (cazul tău acum) → reia de la Pasul A.2: instalezi `pipeline.yaml`,
  re-autorizezi conexiunea GitHub în consolă, apoi pipeline-ul pornește singur.

…și în ~15 minute totul e din nou live, cu un `SiteUrl` nou.
