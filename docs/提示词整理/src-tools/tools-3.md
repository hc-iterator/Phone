## gui_click

Click one screen point with real input injection. This moves the real cursor and needs the target to be foreground, so it steals focus — use it only when gui_uia/gui_browser cannot act (canvas, custom-drawn UI). Pair it with gui_verify.

## gui_verify

Prove that an action actually happened: capture the window, run the command, capture again, and report the changed-pixel ratio. Verdict changed/unchanged is explicit — never assume a click worked. Uses screen capture when the window is foreground (avoids the stale-frame problem of WinUI3 apps).

## build

Build with the project-owned scripts and return the exit code, the log tail, and the artifact path with its timestamp. On success it also writes build_info.txt (source commit, dirty flag, toolchain) beside the artifact; on failure it returns the first few compiler errors instead of only the log tail.

## flash

Write a uf2 onto a board and report what the board answered. The default backdoor method asks the running firmware to enter BOOTSEL over serial. Flashing interrupts the running app, and on this rig the BOOTSEL button is the only recovery. Before writing it verifies the mounted BOOTSEL volume identity against the intended board, takes the rig lock, and appends an entry to debug_logs/flash_ledger.jsonl recording the image fingerprint, the source commit and the outcome, so "which image is on the board" stays answerable.

## serial

Read a USB CDC port once for a bounded time and return the captured text. Identify boards by VID/PID rather than COM number, because the number changes on every replug. Opening costs about 4.5 s, so use pico_console when several reads or a send-then-wait are needed. Takes the rig lock, so a concurrent reader fails loudly instead of fighting over the port.
