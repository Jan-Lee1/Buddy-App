$ErrorActionPreference = 'Stop'
$url = 'https://life-manage-rho.vercel.app'

Write-Host '========== TEST 1: /api/feishu/token =========='
try {
  $r1 = Invoke-WebRequest -Uri "$url/api/feishu/token" -Method Post `
    -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 15
  Write-Host "Status: $($r1.StatusCode)"
  Write-Host "Content-Type: $($r1.Headers['Content-Type'])"
  $j1 = ConvertFrom-Json $r1.Content
  Write-Host 'Valid JSON: YES'
  Write-Host "code: $($j1.code)"
  Write-Host "msg: $($j1.msg)"
  $hasTok = if ($j1.tenant_access_token) { 'PRESENT' } else { 'MISSING' }
  Write-Host "tenant_access_token: $hasTok"
  
  $token = $j1.tenant_access_token
  
  Write-Host ''
  Write-Host '========== TEST 2: /api/bitable/.../records =========='
  try {
    $path = '/api/bitable/v1/apps/ZgdibzjlCazLvRsFErnc5QcJnlc/tables/tbl2ufU3dhk9QLAL/records?page_size=1'
    $r2 = Invoke-WebRequest -Uri "$url$path" -Method Get -UseBasicParsing -TimeoutSec 15 `
      -Headers @{ 'Authorization' = ('Bearer ' + $token) }
    Write-Host "Status: $($r2.StatusCode)"
    Write-Host "Content-Type: $($r2.Headers['Content-Type'])"
    try {
      $j2 = ConvertFrom-Json $r2.Content
      Write-Host 'Valid JSON: YES'
      Write-Host "code: $($j2.code)"
      Write-Host "msg: $($j2.msg)"
      if ($j2.data -and $j2.data.items) {
        Write-Host "has_items: YES ($($j2.data.items.Count) records)"
      } else {
        Write-Host 'has_items: NO'
      }
    } catch {
      Write-Host 'Valid JSON: NO'
      $preview = $r2.Content.Substring(0, [Math]::Min(200, $r2.Content.Length))
      Write-Host "Body preview: $preview"
    }
  } catch {
    $s = $_.Exception.Response.StatusCode.value__
    $ct = $_.Exception.Response.Headers['Content-Type']
    $rd = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $bd = $rd.ReadToEnd()
    Write-Host "Status: $s"
    Write-Host "Content-Type: $ct"
    Write-Host 'Valid JSON: NO'
    Write-Host "Is HTML: $($bd -match '<html|<div|The page')"
    Write-Host "Body length: $($bd.Length)"
    Write-Host "Body: $($bd.Substring(0, [Math]::Min(200, $bd.Length)))"
  }
} catch {
  Write-Host "TOKEN ERROR: $($_.Exception.Message)"
}
