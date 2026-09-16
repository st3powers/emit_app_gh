@echo off
REM Start the EMIT app on http://127.0.0.1:8000
REM Run from anywhere: the paths below are relative to this script.
cd /d "%~dp0backend"
"%~dp0venv\Scripts\python.exe" -m uvicorn main:app --reload --port 8000
