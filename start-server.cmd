@echo off
setlocal
set "EXE=%USERPROFILE%\.lmstudio\extensions\backends\llama.cpp-win-x86_64-avx2-2.67.0\llama-server.exe"
set "MODEL=%USERPROFILE%\.lmstudio\models\qwen\Qwen3-4B-GGUF\Qwen_Qwen3-4B-Q4_K_M.gguf"

if not exist "%EXE%" (
  echo [x] 找不到 llama-server.exe：
  echo     %EXE%
  echo     先在 LM Studio 里随便跑一次模型，让它下载好 CPU 后端。
  pause
  exit /b 1
)
if not exist "%MODEL%" (
  echo [x] 找不到模型文件：
  echo     %MODEL%
  pause
  exit /b 1
)

echo 启动 llama-server: http://127.0.0.1:1234/v1
echo 这个窗口别关，关了就断。Ctrl+C 停止。
echo.

"%EXE%" -m "%MODEL%" --host 127.0.0.1 --port 1234 -c 4096 --jinja -ngl 0
pause
