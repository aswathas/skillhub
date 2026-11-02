@echo off
setlocal
rem skillhub - Windows launcher for the one global skill store.
set "SKILLHUB_JS=%~dp0..\..\.skillhub\skillhub.js"
if not exist "%SKILLHUB_JS%" set "SKILLHUB_JS=%USERPROFILE%\.skillhub\skillhub.js"
if not exist "%SKILLHUB_JS%" (
  echo skillhub: cannot find skillhub.js 1>&2
  exit /b 1
)
node "%SKILLHUB_JS%" %*
exit /b %ERRORLEVEL%
