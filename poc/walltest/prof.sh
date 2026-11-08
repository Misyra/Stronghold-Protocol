#!/bin/bash
# poc/walltest/prof.sh — 三开态稳态 --cpu-prof 画像轮：本脚本自己起服（--cpu-prof 挂在主线程与继承 execArgv 的
# worker 线程上），loadgen --attach 打标准形态（600 房 / 2000 人）风暴，测量窗结束后 SIGTERM 收profile。
# 调用方持串行锁。产物：$OUT/prof/<pid 类名>.cpuprofile + loop log + attach JSON + 测量窗两端 epoch ms。
# 用法: poc/walltest/prof.sh [OUT] [DURATION] [WARMUP] [PORT]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
OUT="${1:-/tmp/sp-walltest}"
DUR="${2:-115}"
WARM="${3:-105}"
PORT="${4:-3977}"
PROFDIR="$OUT/prof"
mkdir -p "$PROFDIR"
rm -f "$PROFDIR"/*.cpuprofile "$PROFDIR/loop.log" "$PROFDIR/attach.json" "$PROFDIR/window.txt"

cd "$ROOT"
SP_BATTLE_POOL=1 SP_CONTENT_BUILD_WORKER=1 SP_BOT_PLAN_POOL=1 SP_FRAME_ECONOMY=0 \
SP_LOOP_SAMPLE=1 SP_LOOP_WINDOW_MS=1000 SP_STATE_FILE=off SP_WORKERS=4 \
PORT="$PORT" HOST=127.0.0.1 \
node --cpu-prof --cpu-prof-dir "$PROFDIR" --cpu-prof-interval 500 --cpu-prof-name main.cpuprofile \
  server/index.js 2>&1 | node "$HERE/tee-ts.mjs" --file "$PROFDIR/loop.log" &
TEE_PID=$!
# 等健康
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
SRV_PID=$(lsof -ti :"$PORT" -sTCP:LISTEN | head -1)
echo "[prof] server pid $SRV_PID on $PORT (tee $TEE_PID)"

node tools/loadgen.mjs --attach "$PORT" --loop-log "$PROFDIR/loop.log" \
  --clients 2000 --rooms 600 --rate 20 --duration "$DUR" --warmup "$WARM" --seed 1 \
  --loop-window-ms 1000 --json "$PROFDIR/attach.json"

# 测量窗两端：startedAt + setupMs + warmup*1000 … + duration*1000（loadgen 侧墙钟，epoch ms）
node - "$PROFDIR/attach.json" "$WARM" "$DUR" <<'EOF'
const fs = require('fs');
const [,, jsonPath, warm, dur] = process.argv;
const s = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const startedAt = Date.parse(s.meta.startedAt);
const from = startedAt + (s.phases.setupMs || 0) + Number(warm) * 1000;
const to = from + Number(dur) * 1000;
fs.writeFileSync(jsonPath.replace(/attach\.json$/, 'window.txt'), `${from} ${to}\n`);
console.log(`[prof] measure window epoch ms: ${from} ${to} (setupMs ${s.phases.setupMs}, connectFailed ${s.phases.connectFailed}, humans ${s.server.humans && s.server.humans.avg})`);
EOF

# 收 profile：SIGTERM 优雅停（worker 池 dispose，各线程写自己的 .cpuprofile），最多等 30 s
kill -TERM "$SRV_PID" 2>/dev/null
for i in $(seq 1 60); do
  kill -0 "$SRV_PID" 2>/dev/null || break
  sleep 0.5
done
kill -9 "$SRV_PID" 2>/dev/null
kill -TERM "$TEE_PID" 2>/dev/null
wait "$TEE_PID" 2>/dev/null
ls -la "$PROFDIR"
echo "[prof] done: profiles $(ls "$PROFDIR"/*.cpuprofile 2>/dev/null | wc -l | tr -d ' ') 个, window $(cat "$PROFDIR/window.txt" 2>/dev/null)"
