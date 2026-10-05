@echo off
setlocal
set "motionApp=%~dp0..\..\Motion Blur.exe"
if not exist "%motionApp%" set "motionApp=%~dp0Motion Blur.exe"
if not exist "%motionApp%" (
  echo Keep this launcher beside Motion Blur.exe or in the installed resources\setup folder.
  pause
  exit /b 1
)
echo Checking and installing the official Blur engine. This may download about 180 MB.
start "" /wait "%motionApp%" --install-engine
if errorlevel 1 (
  echo Setup failed. See %LOCALAPPDATA%\Motion Blur\setup\engine-setup.log.
  pause
  exit /b 1
)
echo Blur is ready. You can open Motion Blur.exe now.
pause
