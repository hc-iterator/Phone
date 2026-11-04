## console

在多次调用之间保持一个串口打开，以便与设备进行交互式驱动。`open` 需要支付一次 4–5 秒的端口打开成本，之后 `send`、`read`、`expect` 就很便宜。需要按键驱动的固件时，请用这个工具而不是 pico_serial。`expect` 发送并等待，直到某一行匹配正则表达式，因此无需猜测睡眠时长；超时会明确指出没有匹配到任何内容。每行默认带墙钟时间戳，这使得“每 30 秒闪一下”这种行为可以被证明。台架锁在会话打开期间一直被持有，关闭会话或空闲超时后释放。

## temp

读写本会话 %TEMP% 目录下的文件。这是项目用来放抓包、负载与转储的临时工作区。路径被限制在 %TEMP% 内，无法逃逸。

## git

在主仓库或一个独立的 Agent 空间里运行 git 命令并返回其输出。会改变历史的动词（commit、push、reset、checkout、merge 等）必须设置 `mutate: true` 才被执行。

## run

运行仓库 `tools/` 目录或项目 `dsh-plugins/` 目录下的一个项目脚本（ps1、cmd、bat、py），返回退出码与输出。SWD 工具、进程守卫、Agent 空间脚本、文档门禁与遥测解析器都通过它调用。其它位置的脚本会被拒绝。

## exec

运行一个在白名单内的构建或调试可执行文件，返回退出码与输出。`~\.pico-sdk` 下的工具链目录（cmake、ninja、arm-none-eabi-*、picotool、openocd）以及 Visual Studio 的 vswhere/MSBuild 目录会被前置到 PATH，使这些命令可直接解析。shell 被刻意排除，`cl` 也被排除（它离不开 Visual Studio 开发环境）。项目脚本用 pico_run；MSVC 构建链用 pico_build host-test。
