## gui_launch

Start a program and place its window on the virtual display, so the user never sees it. Uses SetWindowPos with SWP_NOACTIVATE: focus is not stolen. Prefer this over starting programs yourself, otherwise the window lands on the user primary screen.

## gui_place

Move one window to the virtual display (or explicit coordinates) without activating it. Use when a window was started by something else and is sitting on the user screen.

## gui_vdd

Manage the Parsec virtual display: `status` (device + screen list), `add` (plug a virtual monitor), `remove` (unplug by index). A keeper process pings the driver every 50 ms; without it the display is unplugged about a second after being added.

## gui_browser

Talk to a Chromium browser or Electron app over CDP: `tree` returns clickable elements with exact rects, text and CSS selectors; `click` triggers a real click by selector; `type` sets an input value; `list` shows targets; `eval` runs one expression. This never moves the real mouse, so it works on the virtual display without focus.

## gui_uia

Read or act on a window through UI Automation. `tree` returns every control with its type, name, AutomationId and exact rect; `invoke` triggers a control by AutomationId or name WITHOUT moving the mouse or stealing focus — prefer this over coordinate clicking. Works well on Win32/UWP/WPF apps; Chromium web content is NOT exposed (use gui_browser/CDP instead).
