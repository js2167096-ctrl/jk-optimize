@echo off
rem Testes de integração reais no Windows. Uso: scripts\e2e\run-integration.cmd <senha do proprietário>
rem A saída vai para .e2e-shots\log.txt e o resumo para .e2e-shots\resultado.json.
set JKO_TEST_OWNER_PASSPHRASE=%~1
if not exist "%~dp0..\..\.e2e-shots" mkdir "%~dp0..\..\.e2e-shots"
node "%~dp0windows-integration.mjs" > "%~dp0..\..\.e2e-shots\log.txt" 2>&1
echo FIM %ERRORLEVEL% >> "%~dp0..\..\.e2e-shots\log.txt"
set JKO_TEST_OWNER_PASSPHRASE=
