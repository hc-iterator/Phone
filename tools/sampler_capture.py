#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
TMDS 采样探针 —— 串口采集（Python + pyserial 版）

为什么要用 Python：本机 .NET 的 SerialPort.Open() 会【间歇性永久卡死】
（PuTTY 也一样），tools/read_serial.py 的注释里已记录。所以采集一律走 pyserial。

用法：
    python tools\sampler_capture.py                 # 自动探测端口，抓一次
    python tools\sampler_capture.py COM7            # 指定端口
    python tools\sampler_capture.py COM7 30         # 指定端口 + 超时秒数
    python tools\sampler_capture.py COM7 30 status  # 只问状态（发 s）
    python tools\sampler_capture.py --list          # 列出串口（含设备名）

默认把探针 d 命令的输出存到 sampler_capture.txt
（BEGIN ... 若干行十六进制 ... END），随后可用：
    python tools\tmds_decode.py sampler_capture.txt

输出标记只用 ASCII（[RP]/[BT]/[--]）：本机控制台是 GBK 编码，
直接打印星号/叉号这类符号会抛 UnicodeEncodeError 把脚本弄崩。
"""
import sys
import time

# 控制台编码兜底：即使终端是 GBK，也尽量把内容写出去
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("缺少 pyserial。装一下： python -m pip install pyserial")
    sys.exit(1)

OUT_DEFAULT = "sampler_capture.txt"
RP_VID = 0x2E8A          # Raspberry Pi（RP2040/RP2350）官方 VID


def is_bluetooth(p) -> bool:
    d = (p.description or "") + " " + (p.manufacturer or "")
    return ("Bluetooth" in d) or ("蓝牙" in d)


def list_ports_verbose() -> None:
    ports = list(list_ports.comports())
    if not ports:
        print("没找到任何串口")
        return
    for p in ports:
        if p.vid == RP_VID:
            tag = "[RP]"      # Raspberry Pi 芯片 —— 探针就是它
        elif is_bluetooth(p):
            tag = "[BT]"      # 蓝牙虚拟串口 —— 别选
        else:
            tag = "[--]"
        print(f"{tag} {p.device:<8} {p.description}")


def autodetect():
    cands = [p for p in list_ports.comports() if p.vid == RP_VID]
    if not cands:
        cands = [p for p in list_ports.comports() if not is_bluetooth(p)]
    return cands[0].device if cands else None


def main() -> int:
    args = list(sys.argv[1:])
    if "--list" in args:
        list_ports_verbose()
        return 0

    port = None
    timeout_s = 30
    mode = "dump"
    for a in args:
        if a.lower() == "status":
            mode = "status"
        elif a.isdigit():
            timeout_s = int(a)
        else:
            port = a

    if port is None:
        port = autodetect()
        if port is None:
            print("没探测到可用串口，用 --list 看看")
            return 1
        print(f"自动选中串口：{port}")

    try:
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = 115200
        ser.timeout = 0.2
        ser.dtr = True      # 与 read_serial.py 一致：打开时就拉高，避免边沿复位板子
        ser.rts = True
        ser.open()
    except Exception as e:
        print(f"打开 {port} 失败：{e}")
        return 1

    cmd = b"s" if mode == "status" else b"d"
    print(f"已打开 {port}，发送命令 {cmd.decode()} ...")
    time.sleep(0.2)
    ser.reset_input_buffer()
    ser.write(cmd)
    ser.flush()

    buf = []
    done = False
    t0 = time.time()
    while time.time() - t0 < timeout_s and not done:
        try:
            line = ser.readline()
        except Exception:
            continue
        if not line:
            continue
        s = line.decode("utf-8", errors="replace").rstrip("\r\n")
        buf.append(s)
        t = s.strip()
        if mode == "dump" and t == "END":
            done = True
        if mode == "status" and t.startswith("STAT"):
            done = True
    ser.close()

    if not buf:
        print("没收到任何数据。检查：探针是否在跑？端口是否选对（别选蓝牙口）？")
        return 2

    if mode == "status":
        for s in buf:
            if s.strip():
                print("  " + s)
        return 0

    with open(OUT_DEFAULT, "w", encoding="utf-8") as f:
        f.write("\n".join(buf) + "\n")
    print(f"已保存 {OUT_DEFAULT}（{len(buf)} 行，{'收到 END' if done else '超时截断'}）")
    print("下一步： python tools\\tmds_decode.py " + OUT_DEFAULT)
    return 0 if done else 3


if __name__ == "__main__":
    sys.exit(main())
