## status

Report the PicoPhone rig: managed paths, toolchain versions, git branch/head/dirty, USB devices with VID 2E8A, who holds the rig lock, the last image from the flash ledger, and hung debug processes. Read-only; returns the same facts as a json object beside the text so two runs can be compared mechanically.

## github

Fetch a URL from GitHub through the machine-local accelerator. The hosts file points github.com, api.github.com and raw.githubusercontent.com at 127.0.0.1, where Steam++.Accelerator terminates TLS and forwards; that breaks web_fetch (non-public IP) and plain TLS clients (no revocation list for its certificate). This tool talks to that accelerator directly and returns the status line plus the response body. Pass a full URL, a leading-slash API path such as `/rate_limit`, or `owner/repo`.

## gui_windows

List the top-level windows the agent may look at: handle, process, size and screen position, title, minimized flag. This is the only way the agent learns which windows exist — it never receives a whole-screen image. Pass `all: true` to include hidden helper windows (noisy; for debugging only).

## gui_capture

Capture ONE window by handle and save it as PNG, then return the file path. Uses PrintWindow with PW_RENDERFULLCONTENT, so an occluded window still returns its own content (minimized, DRM-protected, exclusive-fullscreen windows return black). Prefer this over any full-screen capture: the agent only ever sees the window it names.

## gui_zoom

Magnifier: given one screen point, return a small image (default 100x100 at native resolution) centred on it with a red crosshair, plus the `origin` that maps the image back to absolute coordinates. Use it when the agent can see something but cannot read it — it never has to guess coordinates blind.
