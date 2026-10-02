#!/usr/bin/env python3
"""Read the board's USB CDC serial output.

Why this exists: .NET's SerialPort.Open() intermittently blocks forever on this
host (confirmed with a hard-timeout job), and PuTTY cannot open the port once
that happens either. pyserial opens the same port reliably, so this is the
stable path for reading board output.

Usage:
    python tools\\read_serial.py [port] [seconds]

Defaults: COM28, 15 seconds. Output goes to stdout; exit code 0 on success.

The port is opened with DTR/RTS asserted *at open time* rather than toggled
afterwards, because a DTR edge resets the board and re-enumerates the USB
device.
"""

import sys
import time

try:
    import serial
except ImportError:
    print("ERROR: pyserial not available", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else "COM7"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0

    # Report what pyserial can actually see: a port listed in the registry but
    # absent here means the device node is gone (ghost port).
    try:
        import serial.tools.list_ports as lp
        seen = [p.device for p in lp.comports()]
        print(f"# enumerated: {seen}", file=sys.stderr)
        if port not in seen:
            print(f"# WARNING: {port} not in pyserial enumeration", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"# enumeration failed: {exc}", file=sys.stderr)

    try:
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = 115200
        ser.bytesize = serial.EIGHTBITS
        ser.parity = serial.PARITY_NONE
        ser.stopbits = serial.STOPBITS_ONE
        ser.timeout = 0.3
        # write_timeout is REQUIRED, not cosmetic. Assigning dtr/rts issues a
        # control request; with no write timeout that call blocks forever and
        # leaves an unkillable process holding the port. Omitting it produced
        # two wedged ports in this project.
        ser.write_timeout = 0.3
        ser.dtr = True
        ser.rts = True
        ser.open()
    except Exception as exc:  # noqa: BLE001 - report and exit, never hang
        print(f"ERROR opening {port}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"# opened {port} @115200, reading {seconds:.0f}s", file=sys.stderr)
    deadline = time.monotonic() + seconds
    total = 0
    try:
        while time.monotonic() < deadline:
            chunk = ser.read(4096)
            if chunk:
                total += len(chunk)
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR reading: {exc}", file=sys.stderr)
    finally:
        try:
            ser.close()
        except Exception:  # noqa: BLE001
            pass

    print(f"\n# read {total} bytes", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
