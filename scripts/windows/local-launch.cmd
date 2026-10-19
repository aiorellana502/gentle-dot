@echo off
node "%~dp0local-launch.mjs"
if errorlevel 1 (
  echo Gentle Dot could not open. See the error above.
  pause
  exit /b 1
)
