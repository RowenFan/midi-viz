#!/bin/zsh
# 打开给 OBS 采集的专用 Chrome 窗口（叠加模式 + 实时 MIDI）。
# 已经开着就只把它切到前面，不再开第二个，免得 OBS 窗口采集抓错。
URL="http://localhost:5178/?live=1&overlay=1"
PROFILE="$HOME/.midi-viz-chrome"

pid=$(pgrep -f -- "--user-data-dir=$PROFILE" | head -1)
if [[ -n "$pid" ]]; then
  # 找到那个 Chrome 的主进程（不是渲染子进程），切到前面
  main=$(ps -o pid=,command= -p $(pgrep -f -- "--user-data-dir=$PROFILE" | tr '\n' ',' | sed 's/,$//') \
    | grep -v -- "--type=" | awk '{print $1}' | head -1)
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is ${main:-$pid}) to true" 2>/dev/null && exit 0
fi

open -na "Google Chrome" --args --user-data-dir="$PROFILE" --app="$URL" \
  --window-size=1280,720 --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding --disable-background-timer-throttling
