@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   正在启动人际关系图谱服务...
echo.

call :findpy
if not defined PYEXE goto :nopython

echo   使用的 Python: %PYEXE%
echo.
%PYEXE% -u server.py %*

echo.
echo   服务已停止。
pause
exit /b 0


:probe
rem 试着执行传进来的 python 命令,看它有没有真的打印出东西。
rem 不能只看退出码 —— Windows 自带的那个 0 字节"应用执行别名"占位程序
rem (%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe)什么都不做、
rem 没有输出、却返回成功。只看退出码会被它骗过去,服务就静默起不来。
set "PROBE="
set "_PF=%TEMP%\relgraph_pyprobe.txt"
del "%_PF%" >nul 2>&1
%* -c "print(1)" > "%_PF%" 2>nul
if exist "%_PF%" set /p PROBE=<"%_PF%"
del "%_PF%" >nul 2>&1
exit /b


:findpy
set "PYEXE="

call :probe py -3
if "%PROBE%"=="1" (
  set "PYEXE=py -3"
  exit /b
)

for /f "delims=" %%P in ('where python 2^>nul') do (
  if not defined PYEXE (
    echo %%P| find /i "WindowsApps" >nul
    if errorlevel 1 (
      call :probe "%%P"
      if "!PROBE!"=="1" set "PYEXE="%%P""
    )
  )
)
if defined PYEXE exit /b

for %%D in (
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  "C:\Python313\python.exe"
  "C:\Python312\python.exe"
  "%USERPROFILE%\anaconda3\python.exe"
  "%USERPROFILE%\miniconda3\python.exe"
  "C:\ProgramData\anaconda3\python.exe"
  "D:\anaconda\python.exe"
) do (
  if not defined PYEXE if exist %%D (
    call :probe %%D
    if "!PROBE!"=="1" set "PYEXE=%%D"
  )
)
exit /b


:nopython
echo   [启动失败] 没有找到可用的 Python。
echo.
echo   最常见的两个原因:
echo.
echo   1. 根本没装 Python
echo      去 https://www.python.org/downloads/ 下载安装,
echo      安装时务必勾选 "Add python.exe to PATH"。
echo.
echo   2. 装了,但被微软商店的占位程序挡住了
echo      Windows 自带一个假的 python.exe,运行它什么都不会发生。
echo      关掉它:设置 - 应用 - 高级应用设置 - 应用执行别名,
echo      把 python.exe 和 python3.exe 两项关掉,然后重新运行本文件。
echo.
pause
exit /b 1
