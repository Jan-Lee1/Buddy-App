@echo off
title 个人管理系统
chcp 65001 >nul
cd /d "D:\software\CodeBuddy CN\My app"

:: ──检查 Node.js ──
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ============================================
    echo   [X] 未检测到 Node.js
    echo   请先安装: https://nodejs.org/
    echo ============================================
    pause
    exit /b 1
)

:: ──检查 DashScope API Key──
if "%DASHSCOPE_API_KEY%"=="" (
    echo ============================================
    echo   [WARNING] 未设置 DASHSCOPE_API_KEY
    echo   AI 智能解析功能将不可用
    echo   设置方法: set DASHSCOPE_API_KEY=sk-xxx
    echo   申请地址: https://dashscope.console.aliyun.com/
    echo ============================================
    echo.
)

:: ──关闭已有的端口 3000 进程──
echo [*] 检查端口 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    echo [*] 关闭旧进程 PID=%%a...
    taskkill /f /pid %%a >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: ──启动服务器──
echo.
echo ============================================
echo   个人管理系统 · 服务启动中...
echo   http://localhost:3000
echo ============================================
echo.

:: 在独立最小化窗口中运行服务器
start "Server" /min cmd /c "title 个人管理系统-服务 && node "D:\software\CodeBuddy CN\My app\server.js""

:: ──等待服务器就绪──
echo [*] 等待服务器就绪...
ping -n 4 127.0.0.1 >nul

:: ──确认端口已监听──
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do set SPID=%%a
if defined SPID (
    echo [OK] 服务器已启动 (PID=%SPID%)
    echo [OK] 正在打开浏览器...
    start http://localhost:3000
) else (
    echo [X] 服务器启动失败！
    echo     可能原因: 端口3000被占用 / server.js 错误
    echo     请手动检查: node "D:\software\CodeBuddy CN\My app\server.js"
    pause
    exit /b 1
)

echo.
echo 浏览器已打开。按任意键停止服务器并退出...
pause >nul

:: 退出时停止服务器
if defined SPID (
    taskkill /f /pid %SPID% >nul 2>&1
    echo 服务器已停止。
)
