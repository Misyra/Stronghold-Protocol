#!/bin/bash
# poc/walltest/wall.sh — 2026-11-08 容量墙复测的两态基准（ABBA）与加压梯。调用方持串行锁（/tmp/sp-serial-lock），
# 本脚本不自己拿锁：轮次要逐轮看结果定拐点走向，不适合一把跑死。
#   两态：off = 四项全关；on = 三开（SP_CONTENT_BUILD_WORKER + SP_BATTLE_POOL + SP_BOT_PLAN_POOL），SP_FRAME_ECONOMY 关。
#   标准形态：600 房 / 2000 人（--rate 20 --duration 115 --warmup 105 --loop-window-ms 1000 --workers 4 --seed 1）。
# 用法：
#   poc/walltest/wall.sh abba [OUT]        # 4 轮：off/on/on/off（每态 ≥2 轮的判定闸）
#   poc/walltest/wall.sh rung N C [OUT]    # 加压一档：N 房 / C 人（三开态；N=1000 房为服务器上限）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${3:-/tmp/sp-walltest}"
case "${1:-}" in
  abba)
    node "$HERE/round.mjs" --tag ab1-off --state off --out "$OUT"
    node "$HERE/round.mjs" --tag ab2-on --state on --extra "--plan-pool 1" --out "$OUT"
    node "$HERE/round.mjs" --tag ab3-on --state on --extra "--plan-pool 1" --out "$OUT"
    node "$HERE/round.mjs" --tag ab4-off --state off --out "$OUT"
    ;;
  rung)
    rooms="${2:?rooms}"; clients="${3:?clients}"
    extra="--plan-pool 1 --max-connections 6000 --max-rooms 1000"
    node "$HERE/round.mjs" --tag "rung-${rooms}x${clients}" --state on --extra "$extra" \
      --rooms "$rooms" --clients "$clients" --out "$OUT"
    ;;
  *)
    echo "usage: wall.sh abba [OUT] | wall.sh rung ROOMS CLIENTS [OUT]" >&2; exit 2 ;;
esac
