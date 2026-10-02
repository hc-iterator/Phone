@echo off
REM ============================================================================
REM  tools\git.cmd - run safe, read-only git inspections and local commits
REM
REM  Usage:
REM     tools\git.cmd status              -> git status --short
REM     tools\git.cmd log [n]             -> last n commits (default 5)
REM     tools\git.cmd commit "message"    -> git add -A + commit
REM     tools\git.cmd push                -> git push
REM
REM  Deliberately NOT supported: history rewriting, force push, branch delete,
REM  reset --hard. Those can destroy work and stay manual/approved.
REM
REM  Writes only inside this repository: git_log.txt
REM  Last line is GIT_EXIT=<code>.
REM ============================================================================

cd /d "%~dp0.."
if not exist debug_logs mkdir debug_logs
set "LOG=debug_logs\git_log.txt"
set "GIT=%USERPROFILE%\.pico-sdk\git\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=status"

if /I "%CMD%"=="status" (
    echo ==== git status --short ==== > "%LOG%"
    "%GIT%" status --short >> "%LOG%" 2>&1
    goto :done
)

if /I "%CMD%"=="log" (
    if "%~2"=="" (
        echo ==== git log -5 ==== > "%LOG%"
        "%GIT%" log --oneline -5 >> "%LOG%" 2>&1
    ) else (
        echo ==== git log -%~2 ==== > "%LOG%"
        "%GIT%" log --oneline -%~2 >> "%LOG%" 2>&1
    )
    goto :done
)

if /I "%CMD%"=="commit" (
    REM A message is required -- either as argument 2, or in _commit_msg.txt,
    REM which is how multi-line messages get in (cmd cannot pass newlines).
    if "%~2"=="" (
        if not exist "_commit_msg.txt" (
            echo ERROR: commit needs a message argument or _commit_msg.txt > "%LOG%"
            echo GIT_EXIT=1 >> "%LOG%"
            exit /b 1
        )
    )
    echo ==== git add -A ==== > "%LOG%"
    "%GIT%" add -A >> "%LOG%" 2>&1
    echo. >> "%LOG%"
    echo ==== git commit ==== >> "%LOG%"
    if exist "_commit_msg.txt" (
        "%GIT%" commit -F "_commit_msg.txt" >> "%LOG%" 2>&1
        REM Transient input, not a repo artifact: drop it once used.
        del /q "_commit_msg.txt" 2>nul
    ) else (
        "%GIT%" commit -m "%~2" >> "%LOG%" 2>&1
    )
    echo. >> "%LOG%"
    echo ==== resulting HEAD ==== >> "%LOG%"
    "%GIT%" log --oneline -1 >> "%LOG%" 2>&1
    goto :done
)

if /I "%CMD%"=="push" (
    echo ==== git push ==== > "%LOG%"
    "%GIT%" push >> "%LOG%" 2>&1
    goto :done
)

REM Message-only amend. Use solely to fix a malformed message on a commit that
REM has not been pushed; it must not be used to alter committed content.
if /I "%CMD%"=="amend" (
    if not exist "_commit_msg.txt" (
        echo ERROR: amend needs _commit_msg.txt > "%LOG%"
        echo GIT_EXIT=1 >> "%LOG%"
        exit /b 1
    )
    echo ==== git commit --amend -F _commit_msg.txt ==== > "%LOG%"
    "%GIT%" commit --amend -F "_commit_msg.txt" >> "%LOG%" 2>&1
    del /q "_commit_msg.txt" 2>nul
    echo. >> "%LOG%"
    "%GIT%" log --oneline -1 >> "%LOG%" 2>&1
    goto :done
)

echo ERROR: unknown subcommand "%CMD%" > "%LOG%"
echo GIT_EXIT=1 >> "%LOG%"
exit /b 1

:done
set RC=%ERRORLEVEL%
echo. >> "%LOG%"
echo GIT_EXIT=%RC% >> "%LOG%"
exit /b %RC%
