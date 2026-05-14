Set-Location "c:\Users\Scent\Project\PostureGuard\posture-guard"
Start-Process powershell -ArgumentList "-NoExit -Command npm run dev"
Start-Sleep 3
Start-Process "http://localhost:3000"
