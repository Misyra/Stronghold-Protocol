#!/bin/sh
# poc/botplan/ab.sh — SP_BOT_PLAN_POOL 的 A/B 轮次（AGENTS「Performance acceptance」协议）：
#   - ABBA / ABAB 交替，每形态 ≥4 轮，每轮输出原始 JSON（loadgen 的 [loop] 窗口全样本）；
#   - A/B 变体只差一个变量：子服务器的 SP_BOT_PLAN_POOL（--plan-pool 1|0），其余（构建、端口、seed、
#     workers、预热/计量窗）逐字节相同；
#   - 串行锁内运行（同一时刻只有这一轮测量）。
# 用法: sh poc/botplan/ab.sh <shape> <rounds> <outdir>
#   shape: wave（16 房 × 2 客户端 + 1 bot/房）| steady（4 房 × 3 客户端 + 1 bot/房）
set -eu
SHAPE="${1:-wave}"
ROUNDS="${2:-4}"
OUT="${3:-/tmp/sp-botplan-ab}"
mkdir -p "$OUT"

case "$SHAPE" in
  wave)   ARGS="--clients 32 --rooms 16" ;;
  steady) ARGS="--clients 12 --rooms 4" ;;
  *) echo "unknown shape: $SHAPE" >&2; exit 1 ;;
esac

# ABBA 序列（第 1、4 轮 off，2、3 轮 on）；轮数 >4 时按 ABAB 续
i=0
while [ "$i" -lt "$ROUNDS" ]; do
  case $((i % 4)) in
    0|3) PP=0 ;;
    1|2) PP=1 ;;
  esac
  START=$(date '+%F %T')
  echo "=== [$SHAPE] round $((i+1))/$ROUNDS plan-pool=$PP start $START ==="
  node tools/loadgen.mjs $ARGS --rate 20 --duration 115 --warmup 105 --seed 1 \
    --workers 4 --rehearsal-bot --loop-window-ms 1000 --sample-ms 1000 --quiet \
    --plan-pool "$PP" --json "$OUT/$SHAPE-r$((i+1))-pp$PP.json"
  END=$(date '+%F %T')
  echo "=== [$SHAPE] round $((i+1))/$ROUNDS plan-pool=$PP end $END ==="
  i=$((i+1))
done
echo "[$SHAPE] done -> $OUT"
