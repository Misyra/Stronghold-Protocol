param(
    [Parameter(Mandatory = $true)][uri]$Url,
    [ValidateRange(10, 3600)][int]$IntervalSeconds = 30,
    [string]$OutputFile = (Join-Path (Get-Location) 'network-probe.jsonl'),
    [ValidateRange(1, 2147483647)][int]$Count = 2147483647
)
$ErrorActionPreference = 'Stop'
if ($Url.Scheme -notin @('http', 'https') -or $Url.UserInfo) {
    throw 'Use an http(s) URL without embedded credentials.'
}
$taskCurl = (Get-Command curl.exe -ErrorAction Stop).Source
$taskCulture = [Globalization.CultureInfo]::InvariantCulture
$taskOutput = [IO.Path]::GetFullPath($OutputFile)
$taskParent = [IO.Path]::GetDirectoryName($taskOutput)
[IO.Directory]::CreateDirectory($taskParent) | Out-Null
Write-Host "Recording to $taskOutput. Press Ctrl-C to stop."
for ($taskRound = 0; $taskRound -lt $Count; $taskRound++) {
    $taskStarted = [DateTime]::UtcNow
    # A fresh connection per sample separates DNS/TCP/TLS from server waiting.
    # No redirects: a changed route must be visible rather than silently followed.
    $taskLines = @(& $taskCurl --silent --show-error --head --output NUL --connect-timeout 10 --max-time 20 --write-out '%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total},%{http_code}' $Url.AbsoluteUri 2>&1)
    $taskExit = $LASTEXITCODE
    $taskLast = if ($taskLines.Count) { [string]$taskLines[-1] } else { '' }
    $taskParts = $taskLast.Split(',')
    $taskRecord = [ordered]@{ timestamp = $taskStarted.ToString('o'); curlExit = $taskExit }
    if ($taskParts.Count -eq 6 -and $taskLast -match '^[0-9.,]+$') {
        $taskRecord.dnsMs = [double]::Parse($taskParts[0], $taskCulture) * 1000
        $taskRecord.connectMs = [double]::Parse($taskParts[1], $taskCulture) * 1000
        $taskRecord.tlsMs = [double]::Parse($taskParts[2], $taskCulture) * 1000
        $taskRecord.firstByteMs = [double]::Parse($taskParts[3], $taskCulture) * 1000
        $taskRecord.totalMs = [double]::Parse($taskParts[4], $taskCulture) * 1000
        $taskRecord.status = [int]$taskParts[5]
    } else {
        $taskRecord.status = $null
        $taskRecord.parseError = $true
    }
    [IO.File]::AppendAllText($taskOutput, (($taskRecord | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Write-Host ($taskRecord | ConvertTo-Json -Compress)
    if ($taskRound + 1 -lt $Count) {
        $taskRemaining = $IntervalSeconds - ([DateTime]::UtcNow - $taskStarted).TotalSeconds
        if ($taskRemaining -gt 0) { Start-Sleep -Milliseconds ([int]($taskRemaining * 1000)) }
    }
}
