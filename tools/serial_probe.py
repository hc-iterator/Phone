#!/usr/bin/env python3
"""Diagnose which step of opening the serial port blocks.

Writes progress markers to a file as it goes, so that if the process hangs and
is killed, the last marker still says where it stopped. stdout cannot be
trusted for this because a killed process loses its buffered output.

Usage: python tools/serial_probe.py <port> <logfile>
"""

import sys
import time

try:
    import serial
except ImportError:
    print("pyserial missing", file=sys.stderr)
    sys.exit(2)

port = sys.argv[1] if len(sys.argv) > 1 else "COM28"
logpath = sys.argv[2] if len(sys.argv) > 2 else "serial_probe_log.txt"


def mark(msg: str) -> None:
    with open(logpath, "a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        fh.flush()


mark(f"start port={port}")

mark("import ok")

# Enumerate first; constructing/opening is what blocks.
import serial.tools.list_ports as lp  # noqa: E402

ports = [p.device for p in lp.comports()]
mark(f"enumerated ports: {ports}")

if port not in ports:
    mark(f"ABORT: {port} not in enumeration")
    sys.exit(3)

mark("constructing Serial object")
ser = serial.Serial()
ser.port = port
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = True
ser.rts = True
mark("Serial object constructed; calling open()")
ser.open()
mark("open() returned")

try:
    data = ser.read(4096)
    mark(f"read returned {len(data)} bytes")
finally:
    ser.close()
    mark("closed")

mark("done")
