@ECHO OFF
SETLOCAL
IF %PLAYWRIGHT_NODEJS_PATH%x == x SET PLAYWRIGHT_NODEJS_PATH="%~dp0\node.exe"
"%PLAYWRIGHT_NODEJS_PATH%" "%~dp0\package\lib\cli\cli.js" %*
