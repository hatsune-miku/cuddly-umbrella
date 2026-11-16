@echo off
rem KFC restores dependencies during setup; extracted ZIPs prepare them on first launch.
setlocal
set "HERE=%~dp0"
set "KOOK_PLUGIN_TOOLS_ROOT=%HERE:~0,-1%"
where node >nul 2>&1
if errorlevel 1 goto missing_node
pushd "%HERE%"
if errorlevel 1 goto directory_failed
node -e "require('asar'); require('fflate')" >nul 2>&1
if not errorlevel 1 goto run
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_npm
echo Preparing required components for the first launch...
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 goto setup_failed
node -e "require('asar'); require('fflate')" >nul 2>&1
if errorlevel 1 goto setup_failed

:run
node "%HERE%src\main.js" %*
set "RESULT=%ERRORLEVEL%"
popd
if "%RESULT%"=="0" goto done
goto failed

:missing_node
echo Node.js was not found. Install Node.js LTS, then open this launcher again.
set "RESULT=1"
goto failed

:directory_failed
echo Could not open the tool folder. Check its path and permissions.
set "RESULT=1"
goto failed

:missing_npm
echo npm was not found. Reinstall Node.js LTS with npm enabled, then try again.
goto setup_error

:setup_failed
echo Required components could not be prepared. Check the network and the npm error above.

:setup_error
popd
set "RESULT=1"

:failed
echo.
echo Startup failed. Review the error above.
if not "%KOOK_PLUGIN_TOOLS_NO_PAUSE%"=="1" pause

:done
endlocal & exit /b %RESULT%
