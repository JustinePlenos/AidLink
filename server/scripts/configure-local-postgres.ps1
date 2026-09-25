param(
  [Parameter(Mandatory = $true)][string]$SecretFile,
  [Parameter(Mandatory = $true)][string]$StatusFile
)

$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$createdb = 'C:\Program Files\PostgreSQL\17\bin\createdb.exe'
$hbaPath = 'C:\Program Files\PostgreSQL\17\data\pg_hba.conf'
$serviceName = 'postgresql-x64-17'
$hbaBackup = $null
$plainPointer = [IntPtr]::Zero
$stage = 'decrypting credential handoff'

try {
  $encrypted = (Get-Content -LiteralPath $SecretFile -Raw).Trim()
  $secure = $encrypted | ConvertTo-SecureString
  $plainPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $credentials = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($plainPointer) | ConvertFrom-Json)
  if (-not $credentials.superPassword -or -not $credentials.appPassword) {
    throw 'The encrypted credential handoff is invalid.'
  }
  $stage = 'preparing temporary localhost authentication'
  $hbaBackup = $hbaPath + '.aidlink-elevation-backup'
  Copy-Item -LiteralPath $hbaPath -Destination $hbaBackup -Force
  $original = [IO.File]::ReadAllText($hbaPath)
  $trusted = [regex]::Replace($original, '(?m)^(\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+)\S+', '${1}trust')
  $trusted = [regex]::Replace($trusted, '(?m)^(\s*host\s+all\s+all\s+::1/128\s+)\S+', '${1}trust')
  if ($trusted -eq $original) { throw 'The localhost authentication entries were not found.' }
  [IO.File]::WriteAllText($hbaPath, $trusted, (New-Object Text.UTF8Encoding($false)))
  $stage = 'restarting PostgreSQL with temporary localhost authentication'
  Restart-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

  $stage = 'configuring database roles'
  $credentialSql = @"
ALTER ROLE postgres WITH PASSWORD '$($credentials.superPassword)';
DO `$aidlink`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidlink_app') THEN
    CREATE ROLE aidlink_app LOGIN;
  END IF;
END
`$aidlink`$;
ALTER ROLE aidlink_app WITH LOGIN PASSWORD '$($credentials.appPassword)';
"@
  $credentialSql | & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw 'Unable to configure PostgreSQL roles.' }

  $stage = 'creating the AidLink database'
  $databaseOutput = & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -q -tAc "SELECT 1 FROM pg_database WHERE datname = 'aidlink'"
  if (($databaseOutput | Out-String).Trim() -ne '1') {
    & $createdb -h 127.0.0.1 -p 5432 -U postgres -O aidlink_app aidlink
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the AidLink database.' }
  } else {
    'ALTER DATABASE aidlink OWNER TO aidlink_app;' | & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Unable to set the AidLink database owner.' }
  }
  @{ status = 'configured'; database = 'aidlink'; role = 'aidlink_app' } |
    ConvertTo-Json | Set-Content -LiteralPath $StatusFile -Encoding UTF8
} catch {
  @{ status = 'failed'; message = "${stage}: $($_.Exception.Message)" } |
    ConvertTo-Json | Set-Content -LiteralPath $StatusFile -Encoding UTF8
  exit 1
} finally {
  if ($hbaBackup -and (Test-Path -LiteralPath $hbaBackup)) {
    Copy-Item -LiteralPath $hbaBackup -Destination $hbaPath -Force
    Restart-Service -Name $serviceName -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $hbaBackup -Force -ErrorAction SilentlyContinue
  }
  if ($plainPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($plainPointer)
  }
  Remove-Item -LiteralPath $SecretFile -Force -ErrorAction SilentlyContinue
}
