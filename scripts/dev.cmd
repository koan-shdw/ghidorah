@echo off
rem Ghidorah Dev: builds the current source and runs it beside the installed copy, with its own data and keys.
title Ghidorah Dev
cd /d "%~dp0.."
call npm start || pause
