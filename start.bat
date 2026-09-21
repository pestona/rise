@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js не найден. Установи его с https://nodejs.org/
    pause
    exit /b 1
)

if not exist ".env" (
    echo Файл .env не найден.
    if exist ".env.example" copy /y ".env.example" ".env" >nul
    echo Создал .env из примера. Открой его и впиши DISCORD_TOKEN, CLIENT_ID и GUILD_ID.
    notepad ".env"
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Устанавливаю зависимости...
    call npm install
    if errorlevel 1 (
        echo Не удалось установить пакеты.
        pause
        exit /b 1
    )
)

echo Запускаю бота...
node src\index.js
echo.
echo Бот остановлен.
pause
