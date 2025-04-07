#!/bin/bash
set -e
set -x
cd "$(dirname "$0")"
cp ../../../pmb887x-emu/bsp/examples/apoxi_open_boot/build/app.elf ../examples/data/apoxi-unlock.elf
