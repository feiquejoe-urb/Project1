@echo off
chcp 65001 >nul
title Common Ground 本地小样
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在首次安装依赖，请稍候……
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo Common Ground 正在启动……
echo 网页地址：http://127.0.0.1:5173
echo 保持此窗口开启；结束时按 Ctrl+C。
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5173'"
call npm run dev

echo.
echo 服务已停止。
pause
