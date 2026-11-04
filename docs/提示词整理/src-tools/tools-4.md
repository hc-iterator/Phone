## console

Keep one serial port open across calls and drive the board interactively. `open` pays the 4-5 s port-open cost once, then `send` / `read` / `expect` are cheap — use this instead of pico_serial when a firmware is key-driven. `expect` sends and waits until a line matches a regular expression, so no sleep duration has to be guessed; a timeout says explicitly that nothing matched. Lines carry wall-clock timestamps by default, which is what makes "flashes every 30 s" provable. The rig lock is held while the session is open and released on close or after the idle timeout.

## temp

Read and write files under the session %TEMP% directory, the scratch area the project uses for captures, payloads and dumps. Paths are confined to %TEMP% and cannot escape it.

## git

Run git in the main repository or in one isolated agent space and return its output. History-changing verbs (commit, push, reset, checkout, merge, ...) are refused unless mutate is true.

## run

Run one project script under the repository tools/ directory or the project dsh-plugins/ directory (ps1, cmd, bat, py) and return its exit code and output. This is how the SWD tool, the process guard, the agent-space scripts, the documentation gates and the telemetry parsers are reached; scripts elsewhere are refused.

## exec

Run one allow-listed build or debug executable and return its exit code and output. The ~\\.pico-sdk toolchain directories (cmake, ninja, arm-none-eabi-*, picotool, openocd) and the Visual Studio vswhere/MSBuild directories are prepended to PATH for the child, so those names resolve even though they are not on the system PATH. Shells are deliberately excluded, and so is `cl`, which cannot run without a Visual Studio developer environment; use pico_run for project scripts and pico_build host-test for the MSVC build chain.
