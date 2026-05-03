$appFile = "c:\Users\kprv9\.gemini\antigravity\scratch\app.js"
$newFile = "c:\Users\kprv9\.gemini\antigravity\scratch\tracer_new.js"

$lines = Get-Content $appFile
$newContent = Get-Content $newFile

# Lines 833-1158 (0-indexed: 832-1157)
$before = $lines[0..831]
$after = $lines[1158..($lines.Length-1)]

$result = $before + $newContent + $after
$result | Set-Content $appFile -Encoding UTF8

Write-Host "Done. Total lines: $($result.Length)"
