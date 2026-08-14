$ErrorActionPreference = 'Stop';

Write-Output "Step 1: Get token..."
$r1 = Invoke-WebRequest -Uri 'https://life-manage-rho.vercel.app/api/feishu/token' `
  -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 15;
$token = (ConvertFrom-Json $r1.Content).tenant_access_token;
if (-not $token) { Write-Output "FAIL: No token"; exit 1; }
Write-Output "Token: PRESENT"

Write-Output ""
Write-Output "TEST A: bitable proxy (main table, listRecords)"
Write-Output "PATH: /api/bitable/v1/apps/ZgdibzjlCazLvRsFErnc5QcJnlc/tables/tbl2ufU3dhk9QLAL/records?page_size=1"

try {
  $r2 = Invoke-WebRequest -Uri 'https://life-manage-rho.vercel.app/api/bitable/v1/apps/ZgdibzjlCazLvRsFErnc5QcJnlc/tables/tbl2ufU3dhk9QLAL/records?page_size=1' `
    -Method Get -UseBasicParsing -TimeoutSec 15 -Headers @{ 'Authorization' = ('Bearer ' + $token) };

  Write-Output "Status: $($r2.StatusCode)"
  Write-Output "Content-Type: $($r2.Headers['Content-Type'])"
  Write-Output "Body length: $($r2.Content.Length)"
  Write-Output "Body: $($r2.Content.Substring(0, [Math]::Min(500, $r2.Content.Length)))"

} catch {
  if ($_.Exception.Response) {
    $status = $_.Exception.Response.StatusCode.value__;
    $ct = $_.Exception.Response.Headers['Content-Type'];
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream());
    $body = $reader.ReadToEnd();

    Write-Output "Status: $status"
    Write-Output "Content-Type: $ct"
    Write-Output "Body length: $($body.Length)"
    Write-Output "Body: $($body.Substring(0, [Math]::Min(500, $body.Length)))"
    Write-Output "Is HTML: $($body -match '<!DOCTYPE|<html')"
  } else {
    Write-Output "ERROR: $($_.Exception.Message)"
  }
}

Write-Output ""
Write-Output "TEST B: simple bitable path without complex params"
Write-Output "PATH: /api/bitable/v1/apps/ZgdibzjlCazLvRsFErnc5QcJnlc"

try {
  $r3 = Invoke-WebRequest -Uri 'https://life-manage-rho.vercel.app/api/bitable/v1/apps/ZgdibzjlCazLvRsFErnc5QcJnlc' `
    -Method Get -UseBasicParsing -TimeoutSec 15 -Headers @{ 'Authorization' = ('Bearer ' + $token) };

  Write-Output "Status: $($r3.StatusCode)"
  Write-Output "Content-Type: $($r3.Headers['Content-Type'])"
  Write-Output "Body: $($r3.Content.Substring(0, [Math]::Min(500, $r3.Content.Length)))"

} catch {
  if ($_.Exception.Response) {
    $status = $_.Exception.Response.StatusCode.value__;
    $ct = $_.Exception.Response.Headers['Content-Type'];
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream());
    $body = $reader.ReadToEnd();
    Write-Output "Status: $status"
    Write-Output "Content-Type: $ct"
    Write-Output "Body: $($body.Substring(0, [Math]::Min(500, $body.Length)))"
  } else {
    Write-Output "ERROR: $($_.Exception.Message)"
  }
}
