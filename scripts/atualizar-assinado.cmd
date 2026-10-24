@echo off
rem Atualiza o app instalado e gera o manifesto assinado. Uso: scripts\atualizar-assinado.cmd <senha do proprietário>
rem Saída em release\atualizar-log.txt
set JKO_OWNER_PASSPHRASE=%~1
if not exist "%~dp0..\release" mkdir "%~dp0..\release"
call npm.cmd run atualizar > "%~dp0..\release\atualizar-log.txt" 2>&1
echo FIM %ERRORLEVEL% >> "%~dp0..\release\atualizar-log.txt"
set JKO_OWNER_PASSPHRASE=
