#!/usr/bin/env python3
"""Trace exactly where opening the board's serial port blocks.

Writes a marker to a log file before and after every step, flushing each time.
If the process is killed mid-way the log still shows the last step reached,
which is the whole point -- stdout is unreliable for a killed process.

Every potentially blocking operation is given a timeout so that a busy or
wedged port produces an ERROR rather than an unkillable hang. write_timeout in
particular matters: setting DTR/RTS issues a control request and will block
forever without it.

Usage: python tools/serial_open_trace.py <port> <logfile>
"""

import sys
import time

LOG = sys.argv[2] if len(sys.argv) > 2 else "serial_open_trace.txt"
PORT = sys.argv[1] if len(sys.argv) > 1 else "COM28"


def mark(msg: str) -> None:
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        fh.flush()


mark(f"=== start port={PORT} ===")

try:
    import serial
    mark("import serial ok")
except Exception as exc:  # noqa: BLE001
    mark(f"import serial FAILED: {exc}")
    sys.exit(2)

# Enumerate first: pyserial's list can disagree with the registry, and that
# disagreement alone explains "port exists but cannot be opened".
try:
    import serial.tools.list_ports as lp
    mark(f"enumerated: {[p.device for p in lp.comports()]}")
except Exception as exc:  # noqa: BLE001
    mark(f"enumeration failed: {exc}")

mark("constructing Serial (not open yet)")
ser = serial.Serial()
ser.port = PORT
ser.baudrate = 115200
ser.timeout = 0.3          # read timeout
ser.write_timeout = 0.3    # stops DTR/RTS control requests blocking forever
mark("constructed; calling open()")

try:
    ser.open()
    mark("open() RETURNED")
except Exception as exc:  # noqa: BLE001
    mark(f"open() RAISED: {type(exc).__name__}: {exc}")
    sys.exit(3)

try:
    mark("setting DTR")
    ser.dtr = True
    mark("DTR set")
    ser.rts = True
    mark("RTS set")
    data = ser.read(2048)
    mark(f"read returned {len(data)} bytes")
finally:
    try:
        ser.close()
        mark("closed")
    except Exception as exc:  # noqa: BLE001
        mark(f"close failed: {exc}")

mark("=== done ===")
