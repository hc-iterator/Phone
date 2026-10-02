#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TMDS 采样探针 —— 串口采集（Python + pyserial 版）

为什么要用 Python：本机 .NET 的 SerialPort.Open() 会【间歇性永久卡死】
（PuTTY 也一样），tools/read_serial.py 的注释里已记录。所以采集一律走 pyserial。

用法：
    python tools\sampler_capture.py                 # 自动探测端口，抓一次
    python tools\sampler_capture.py COM7            # 指定端口
    python tools\sampler_capture.py COM7 30         # 指定端口 + 超时秒数
    python tools\sampler_capture.py COM7 30 status  # 只问状态（发 's'）
    python tools\sampler_capture.py --list          # 列出串口（含设备名）

默认把探针 'd' 命令的输出存到 sampler_capture.txt
（BEGIN ... 若干行十六进制 ... END），随后可用：
    python tools\tmds_decode.py sampler_capture.txt
"""
import sys, time, glob

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("缺少 pyserial。装一下： python -m pip install pyserial")
    sys.exit(1)

OUT_DEFAULT = "sampler_capture.txt"


def list_ports_verbose():
    ports = list(list_ports.comports())
    if not ports:
        print("没找到任何串口")
        return
    for p in ports:
        tag = "  "
        if (p.vid == 0x2E8A):
            tag = "★ "          # Raspberry Pi 芯片（探针就是它）
        elif "Bluetooth" in (p.description or "") or "蓝牙" in (p.description or ""):
            tag = "✗ "          # 蓝牙虚拟串口，别选
        print(f"{tag}{p.device:<8} {p.description}")


def autodetect():
    """优先选 Raspberry Pi VID (2E8A) 的口"""
    cands = [p for p in list_ports.comports() if p.vid == 0x2E8A]
    if cands:
        return cands[0].device
    cands = [p for p in list_ports.comports()
             if "Bluetooth" not in (p.description or "") and "蓝牙" not in (p.description or "")]
    return cands[0].device if cands else None


def main():
    args = [a for a in sys.argv[1:]]
    if "--list" in args:
        list_ports_verbose()
        return 0

    port = None
    timeout_s = 30
    mode = "dump"           # dump | status
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

    # 打开（与 read_serial.py 一致：打开时就拉 DTR/RTS，避免事后边沿复位板子）
    try:
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = 115200
        ser.timeout = 0.2
        ser.dtr = True
        ser.rts = True
        ser.open()
    except Exception as e:
        print(f"打开 {port} 失败：{e}")
        return 1

    print(f"已打开 {port}，发送命令 'd'（dump）…" if mode == "dump" else f"已打开 {port}，发送 's'（status）…")
    time.sleep(0.2)
    ser.reset_input_buffer()
    ser.write(b"d" if mode == "dump" else b"s")
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
        if mode == "dump" and s.strip() == "END":
            done = True
        if mode == "status" and s.startswith("STAT"):
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
    print(f"下一步： python tools\\tmds_decode.py {OUT_DEFAULT}")
    return 0 if done else 3


if __name__ == "__main__":
    sys.exit(main())
