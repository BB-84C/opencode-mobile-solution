@echo off
setlocal DisableDelayedExpansion

rem OpenCode relay-aware launcher wrapper (template).
rem   --relay_server  -> shared-backend lifecycle controller
rem   --local         -> zero-touch escape hatch (untouched real opencode: no probes/modules)
rem   interactive     -> attach through the relay-aware launcher
rem   everything else -> pass straight through to the real opencode binary

if /I "%~1"=="--relay_server" goto :relay_server
if /I "%~1"=="--local" goto :local

set "_OC_INTERACTIVE=0"
if "%~1"==""              set "_OC_INTERACTIVE=1"
if /I "%~1"=="--dir"      set "_OC_INTERACTIVE=1"
if /I "%~1"=="--continue" set "_OC_INTERACTIVE=1"
if /I "%~1"=="-c"         set "_OC_INTERACTIVE=1"
if /I "%~1"=="--session"  set "_OC_INTERACTIVE=1"
if /I "%~1"=="-s"         set "_OC_INTERACTIVE=1"
if /I "%~1"=="--fork"     set "_OC_INTERACTIVE=1"
if /I "%~1"=="--mini"     set "_OC_INTERACTIVE=1"
if "%_OC_INTERACTIVE%"=="1" goto :launch

rem Pass-through to the real OpenCode binary.
set "REAL_OPENCODE=%OPENCODE_REAL_CMD%"
if not defined REAL_OPENCODE set "REAL_OPENCODE=%USERPROFILE%\AppData\Roaming\npm\opencode.cmd"
if not exist "%REAL_OPENCODE%" (
    >&2 echo [FAIL] OpenCode launcher not found at "%REAL_OPENCODE%"
    exit /b 1
)
call "%REAL_OPENCODE%" %*
exit /b %ERRORLEVEL%

:relay_server
set "_OC_CONTROLLER=%OPENCODE_CONTROLLER_SCRIPT%"
if not defined _OC_CONTROLLER set "_OC_CONTROLLER=%USERPROFILE%\.config\opencode\bin\opencode-relay-server.ps1"
pwsh -NoProfile -NoLogo -File "%_OC_CONTROLLER%" %2 %3 %4
exit /b %ERRORLEVEL%

:local
set "_OC_LOCAL=%OPENCODE_LOCAL_SCRIPT%"
if not defined _OC_LOCAL set "_OC_LOCAL=%USERPROFILE%\.config\opencode\bin\opencode-local.ps1"
pwsh -NoProfile -NoLogo -File "%_OC_LOCAL%" %*
exit /b %ERRORLEVEL%

:launch
set "_OC_LAUNCHER=%OPENCODE_LAUNCH_SCRIPT%"
if not defined _OC_LAUNCHER set "_OC_LAUNCHER=%USERPROFILE%\.config\opencode\bin\opencode-launch.ps1"
pwsh -NoProfile -NoLogo -File "%_OC_LAUNCHER%" %*
exit /b %ERRORLEVEL%
