#!/bin/bash
# poc/vanhost/ab600.sh — 标准压测形态（600 房 / 2000 人）参考轮：SP_BATTLE_POOL off/on 各一轮。
# 不计入判定闸，用于容量外推。调用方持串行锁。
set -u
cd /Users/misyra/Dev/sp-wt-vanhost
mkdir -p /tmp/vanhost-ab
run() { # $1=tag $2=json $3...=extra env
  local tag="$1" json="$2"; shift 2
  local start=$(date '+%F %T %z') eps=$(date +%s)
  echo "=== ref600 $tag start $start ==="
  env "$@" node tools/loadgen.mjs --clients 2000 --rooms 600 --rate 20 --duration 115 --warmup 105 --seed 1 \
    --port 3999 --loop-window-ms 1000 --workers 4 --json "$json" --quiet
  local rc=$?
  local end=$(date '+%F %T %z') epe=$(date +%s)
  echo "=== ref600 $tag done rc=$rc $end (wall $((epe-eps))s) ==="
  node -e "
    const fs = require('fs');
    const s = require('$json');
    const w = s.loop.windows;
    const hot = w.map((x, i) => ({ i, max: x.max, p95: x.p95, cpu: x.cpu })).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    fs.appendFileSync('/tmp/vanhost-ab/summary600.txt',
      ['$tag', 'p50max=' + s.loop.p50.max, 'p95mean=' + s.loop.p95.mean, 'p95max=' + s.loop.p95.max,
       'max=' + s.loop.max.max, 'cpuPeak=' + s.loop.cpu.max, 'cpuMean=' + s.loop.cpu.mean,
       'eluMax=' + (s.server.elu ? s.server.elu.max : 'null'), 'rssMax=' + s.server.rssMB.max,
       'inMsg=' + s.clients.inMsgPerSec, 'humans=' + JSON.stringify(s.server.humans), 'hot=' + JSON.stringify(hot)].join(' ') + '\n');
  "
}
: > /tmp/vanhost-ab/summary600.txt
run ref600-off /tmp/vanhost-ab/ref600-off.json SP_BATTLE_POOL=0
run ref600-on  /tmp/vanhost-ab/ref600-on.json  SP_BATTLE_POOL=1
echo "=== ref600 done ==="
cat /tmp/vanhost-ab/summary600.txt
