@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   局域网模式启动 —— 同一个 Wi-Fi 下的其他人也能访问!
echo   在公司网络下请不要使用这个模式。
echo.
python server.py --lan
echo.
echo   服务已停止。
pause
