@echo off
REM ===========================================================================
REM  One-click uninstall of the dsh-picophone DSH plugin bundle.
REM
REM  It removes ONLY what that plugin added to the DSH profile:
REM    1) dependencies["dsh-picophone"] in the profile package.json
REM    2) "dsh-picophone" in dsh.profile.bundles
REM    3) the "- id: picophone" row in cordis.patch.yml
REM    4) node_modules\dsh-picophone (pnpm remove does this one)
REM
REM  It never touches pnpm itself, other plugins, project sources or git repos.
REM
REM  Usage:
REM    uninstall-picophone-plugin.cmd -Yes            uninstall, no prompt
REM    uninstall-picophone-plugin.cmd -DryRun         show what would go
REM    uninstall-picophone-plugin.cmd -Yes -PurgeSource   also delete the source dir
REM    uninstall-picophone-plugin.cmd                 interactive (double-click)
REM
REM  ASCII only by design: cmd.exe reads .cmd with the OEM code page.
REM  Passing any argument suppresses the closing pause.
REM ===========================================================================
setlocal
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-picophone-plugin.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%
