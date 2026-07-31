#!/usr/bin/env bash
# AC9 음성 대조 — 오케스트레이션 도구가 실제로 부재한 환경에서 core 가 도는가
#
# 왜 이 fixture 인가: 이전 판은 PATH 에서 실행파일을 지워 부재를 **인위 구성**했다.
# Claude Code 의 `--bare` 는 제품이 공식 제공하는 최소 모드이고, 그 모드에는
# 병렬 오케스트레이션 도구가 **실제로 없다**. 인위 구성보다 정직한 음성 대조다.
#
# ⚠️ 버전 스탬프 — 아래 BASELINE 은 이 버전에서 실측한 값이다.
#    `--bare` 의 도구 구성은 버전 의존일 수 있으므로, 이 fixture 가 깨지면
#    "우리 코드가 틀렸나" 보다 **"CLI 버전이 바뀌었나"를 먼저 의심**한다.
#
#    BASELINE_CLI_VERSION = 2.1.220
#    BASELINE_OBSERVED_AT = 2026-07-31 (KST)
#    BASELINE_BARE_TOOLS  = Bash,Edit,Read        (3종 — Workflow·Task 부재)
#    BASELINE_FULL_TOOLS  = Workflow·Task 포함     (표준 headless 모드)
#
# 선행 조건: `--bare` 는 OAuth·keychain 을 읽지 않는다 → ANTHROPIC_API_KEY 필요.
#           키가 없으면 이 fixture 는 SKIP 이며, **SKIP 을 PASS 로 세지 않는다.**
set -u

BASELINE_CLI_VERSION="2.1.220"
CLI="${SEARCHFLOW_CLAUDE_BIN:-claude}"

if ! command -v "$CLI" >/dev/null 2>&1; then
  echo "SKIP  claude CLI 없음 — AC9 bare 대조 미수행 (SKIP ≠ PASS)"; exit 3
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SKIP  ANTHROPIC_API_KEY 없음 — --bare 는 OAuth 를 읽지 않는다 (SKIP ≠ PASS)"; exit 3
fi

ver="$("$CLI" --version 2>/dev/null | awk '{print $1}')"
[ "$ver" = "$BASELINE_CLI_VERSION" ] || \
  echo "WARN  CLI 버전 불일치 — baseline=$BASELINE_CLI_VERSION 관측=$ver (아래가 깨지면 여기부터 의심)"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp" || exit 2

# system/init 이벤트의 tools 배열이 결정적 측정면이다 — 모델 자기보고를 믿지 않는다.
"$CLI" -p "ok" --bare --output-format stream-json --verbose --max-turns 1 > init.jsonl 2>/dev/null
[ -s init.jsonl ] || { echo "FAIL  출력 없음 — 측정 자체가 안 됨(0 을 결과로 읽지 않는다)"; exit 1; }

tools="$(node -e '
  const fs=require("fs");
  for (const l of fs.readFileSync("init.jsonl","utf8").split("\n").filter(Boolean)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "system" && o.subtype === "init") { console.log((o.tools||[]).join(",")); break; }
  }')"
[ -n "$tools" ] || { echo "FAIL  init 이벤트에 tools 부재 — 측정면이 사라졌다(계약 변경 의심)"; exit 1; }

echo "관측 도구: $tools"
fail=0
case ",$tools," in *,Workflow,*) echo "FAIL  --bare 에 Workflow 가 있다 — 이 fixture 의 전제(부재)가 깨졌다"; fail=1;; esac
case ",$tools," in *,Task,*)     echo "FAIL  --bare 에 Task 가 있다 — 전제 깨짐"; fail=1;; esac
[ $fail -eq 0 ] && echo "PASS  1·2단 동시 부재 확인 — 3단(순차) 강등이 실환경 경로임"

# 강등 라벨이 실제 문자열로 나오는지 (AC9 의 grep 대상)
plan="$(node "${SEARCHFLOW_SKILL_DIR:-..}/scripts/spawn-plan.mjs" --type factcheck --harness cc --tools "" 2>/dev/null)"
case "$plan" in
  *'parallelism=sequential'*) echo "PASS  강등 라벨 실재 — parallelism=sequential";;
  *) echo "FAIL  강등 라벨 부재 — 보고서에 격하가 안 적힌다"; fail=1;;
esac

exit $fail
