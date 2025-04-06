#!/bin/bash
set -e
set -x
cd "$(dirname "$0")"
cp ../../../pmb887x-emu/bsp/examples/apoxi_open_boot/build/app.bin ../examples/data/apoxi-unlock.bin
