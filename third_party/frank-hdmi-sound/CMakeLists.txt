# SPDX-License-Identifier: GPL-3.0-or-later
#
# Vendored copy of rh1tech/frank-hdmi-audio (README/LICENSE/docs alongside).
#
# The upstream tree keeps sources under src/ and builds the library from
# the top-level CMakeLists. Here only the library is vendored, so this
# file mirrors what upstream's top-level does for the `frank_hdmi_sound`
# target, minus the examples (we have our own app).
#
# Pin configuration for the Waveshare RP2350-PiZero and the PCIe/clock
# divisor are supplied by the parent project as compile definitions /
# cache variables before add_subdirectory(), see the top-level CMakeLists.

cmake_minimum_required(VERSION 3.13)

add_subdirectory(src)
