@echo off
REM ELECTRON_RUN_AS_NODE laesst Electron die main.js als reines Node-Skript laden,
REM dann ist ipcMain undefined und die App stirbt beim Start. Hier hart entfernen.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
call node_modules\.bin\electron.cmd . %*
