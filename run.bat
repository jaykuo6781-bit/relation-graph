@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   正在启动人际关系图谱服务...
echo.
python server.py
echo.
echo   服务已停止。
pause
