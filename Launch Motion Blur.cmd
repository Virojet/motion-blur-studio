@echo off
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Install the development dependencies using the steps in README.md first.
  pause
  exit /b 1
)
if not exist "%~dp0dist\electron\main\main.js" (
  echo Build the app using the steps in README.md first.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
