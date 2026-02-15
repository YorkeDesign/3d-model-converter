@echo off
title USDZ to GLB Converter
setlocal

:: --- Find a free port (default 8080, fallback 8081-8090) ---
set PORT=8080
for /L %%p in (8080,1,8090) do (
    netstat -ano | findstr ":%%p.*LISTENING" >nul 2>&1
    if errorlevel 1 (
        set PORT=%%p
        goto :found
    )
)
:found

:: --- Start the server in the background ---
echo Starting local server on port %PORT%...
start /B python -m http.server %PORT% >nul 2>&1

:: --- Wait a moment for the server to start ---
ping -n 2 127.0.0.1 >nul

:: --- Open the browser ---
echo Opening browser...
start http://localhost:%PORT%/

echo.
echo ============================================
echo   USDZ to GLB Converter is running!
echo   URL: http://localhost:%PORT%/
echo.
echo   Keep this window open while using the app.
echo   Press any key to stop the server and exit.
echo ============================================
echo.
pause >nul

:: --- Clean up: kill the Python server ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo Server stopped. Goodbye!
