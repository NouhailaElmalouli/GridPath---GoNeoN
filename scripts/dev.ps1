$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) {
    py -3.12 -m venv .venv
}

.\.venv\Scripts\Activate.ps1

Write-Host "Workspace ready. Start the API and frontend in separate terminals:"
Write-Host "  cd backend; uvicorn app.main:app --reload --port 8000"
Write-Host "  cd frontend; npm run dev"

