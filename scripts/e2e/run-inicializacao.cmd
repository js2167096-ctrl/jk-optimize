@echo off
rem Testes reais de inicialização. Uso: scripts\e2e\run-inicializacao.cmd <senha do proprietário>
rem A saída vai para .e2e-shots\inicializacao-log.txt
set JKO_TEST_OWNER_PASSPHRASE=%~1
if not exist "%~dp0..\..\.e2e-shots" mkdir "%~dp0..\..\.e2e-shots"
node "%~dp0inicializacao.mjs" > "%~dp0..\..\.e2e-shots\inicializacao-log.txt" 2>&1
echo FIM %ERRORLEVEL% >> "%~dp0..\..\.e2e-shots\inicializacao-log.txt"
set JKO_TEST_OWNER_PASSPHRASE=
