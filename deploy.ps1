[CmdletBinding()]
param(
  [string]$StackName,
  [string]$Region,
  [switch]$SkipBuild,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'

function Get-SamSetting {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$Section,
    [Parameter(Mandatory)] [string]$Configuration
  )

  $sectionPattern = '(?ms)^\[{0}\]\s*(.*?)(?=^\[|\z)' -f [regex]::Escape($Section)
  $sectionContents = [regex]::Match(
    $Configuration,
    $sectionPattern
  ).Groups[1].Value
  $settingPattern = '(?m)^\s*{0}\s*=\s*"([^"]+)"\s*$' -f [regex]::Escape($Name)
  $setting = [regex]::Match(
    $sectionContents,
    $settingPattern
  )

  return $setting.Groups[1].Value
}

function ConvertTo-JavaScriptString {
  param([Parameter(Mandatory)] [string]$Value)

  return $Value | ConvertTo-Json -Compress
}

$repositoryRoot = $PSScriptRoot
$samConfigPath = Join-Path $repositoryRoot 'samconfig.toml'
$frontendConfigPath = Join-Path $repositoryRoot 'frontend\config.js'

if (-not (Test-Path $samConfigPath)) {
  throw "Nu găsesc configurația SAM: $samConfigPath"
}

$samConfig = Get-Content -Raw $samConfigPath
if (-not $StackName) {
  $StackName = Get-SamSetting -Name 'stack_name' -Section 'default.deploy.parameters' -Configuration $samConfig
}
if (-not $Region) {
  $Region = Get-SamSetting -Name 'region' -Section 'default.deploy.parameters' -Configuration $samConfig
}
if (-not $Region) {
  $Region = Get-SamSetting -Name 'region' -Section 'default.global.parameters' -Configuration $samConfig
}
if (-not $StackName -or -not $Region) {
  throw 'Nu am putut determina stack_name sau region din samconfig.toml. Folosește -StackName și -Region.'
}

Push-Location $repositoryRoot
try {
  if (-not $SkipBuild) {
    Write-Host "Construiesc aplicația SAM pentru stack-ul $StackName..."
    & sam build
    if ($LASTEXITCODE -ne 0) {
      throw "sam build a eșuat cu codul $LASTEXITCODE."
    }
  }

  if (-not $SkipDeploy) {
    Write-Host "Deploy în regiunea $Region..."
    & sam deploy
    if ($LASTEXITCODE -ne 0) {
      throw "sam deploy a eșuat cu codul $LASTEXITCODE."
    }
  }

  Write-Host 'Citesc output-urile CloudFormation...'
  $outputsJson = & aws cloudformation describe-stacks `
    --stack-name $StackName `
    --region $Region `
    --query 'Stacks[0].Outputs' `
    --output json
  if ($LASTEXITCODE -ne 0) {
    throw "Nu pot citi output-urile stack-ului $StackName."
  }

  $outputs = $outputsJson | ConvertFrom-Json
  $outputValues = @{}
  foreach ($output in $outputs) {
    $outputValues[$output.OutputKey] = $output.OutputValue
  }

  foreach ($requiredOutput in 'ApiUrl', 'UserPoolClientId', 'Region') {
    if (-not $outputValues[$requiredOutput]) {
      throw "Stack-ul nu conține output-ul obligatoriu $requiredOutput."
    }
  }

  $configContents = @"
// Generat automat de deploy.ps1 din output-urile CloudFormation.
// Nu conține secrete; aceste valori trebuie să fie disponibile în browser.
window.CONFIG = {
  API_URL: $(ConvertTo-JavaScriptString $outputValues.ApiUrl),
  USER_POOL_CLIENT_ID: $(ConvertTo-JavaScriptString $outputValues.UserPoolClientId),
  REGION: $(ConvertTo-JavaScriptString $outputValues.Region),
};
"@

  $temporaryConfigPath = "$frontendConfigPath.tmp"
  Set-Content -Path $temporaryConfigPath -Value $configContents -Encoding utf8
  Move-Item -Path $temporaryConfigPath -Destination $frontendConfigPath -Force

  Write-Host "Configurația frontend a fost actualizată: $frontendConfigPath" -ForegroundColor Green
  Write-Host "API: $($outputValues.ApiUrl)"

  # ── Publicare frontend pe S3 + CloudFront (dacă stack-ul are hosting) ──────
  if ($outputValues.SiteBucketName -and $outputValues.SiteDistributionId) {
    Write-Host "Sincronizez frontend-ul în s3://$($outputValues.SiteBucketName)..."
    & aws s3 sync (Join-Path $repositoryRoot 'frontend') "s3://$($outputValues.SiteBucketName)" `
      --delete `
      --region $Region
    if ($LASTEXITCODE -ne 0) {
      throw 'aws s3 sync a eșuat.'
    }

    # CloudFront servește din cache (CachingOptimized ignoră query string-urile),
    # deci invalidăm totul ca vizitatorii să primească imediat versiunea nouă.
    Write-Host 'Invalidez cache-ul CloudFront...'
    & aws cloudfront create-invalidation `
      --distribution-id $outputValues.SiteDistributionId `
      --paths '/*' `
      --output text `
      --query 'Invalidation.Id'
    if ($LASTEXITCODE -ne 0) {
      throw 'Invalidarea CloudFront a eșuat.'
    }

    Write-Host "Site publicat: $($outputValues.SiteUrl)" -ForegroundColor Green
  } else {
    Write-Host 'Stack-ul nu are încă output-urile de hosting (SiteBucketName/SiteDistributionId); sar peste publicarea frontend-ului.'
  }
} finally {
  Pop-Location
}