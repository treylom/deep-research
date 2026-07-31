#!/usr/bin/env bash
# AC9 음성 대조 — 강등이 일어났을 때 **사유가 라벨에 실리는가** + 부재가 실환경 경로인가
#
# 두 부분으로 나뉜다. 나눈 이유가 이 fixture 의 교훈이다:
#   A. 라벨 계약 검사 — node 만 필요. **항상 돈다.**
#   B. `--bare` 도구 부재 측정 — CLI + API 키 필요. 없으면 SKIP.
# 이전 판은 B 의 선행 조건 검사(SKIP·exit 3)를 **맨 앞에** 뒀다. 그래서 키가 없는 기기에서는
# A 가 **한 번도 실행되지 않았는데** 그 사실이 SKIP 한 줄에 묻혔다 — 검사가 없는 것과
# 검사가 통과한 것이 구분되지 않았다. 독립적인 검사를 남의 선행 조건 뒤에 두지 않는다.
#
# ⚠️ 이 fixture 는 **tier 값을 기대값으로 못 박지 않는다.** 같은 기기·같은 질의가 두 실행에서
#    서로 다른 tier 를 냈다(순차 / 병렬). 주장하는 것은 ① 강등 시 사유가 라벨에 실린다
#    ② 사유가 부재와 거부를 구분한다 — 두 가지뿐이다. 어느 값이 나오는지는 환경·정책이 정한다.
#
#    BASELINE_CLI_VERSION = 2.1.220
#    BASELINE_OBSERVED_AT = 2026-07-31 (KST)
#    BASELINE_BARE_TOOLS  = Bash,Edit,Read        (3종 — Workflow·Task 부재)
set -u

BASELINE_CLI_VERSION="2.1.220"
CLI="${SEARCHFLOW_CLAUDE_BIN:-claude}"
SP="${SEARCHFLOW_SKILL_DIR:-..}/scripts/spawn-plan.mjs"
fail=0

# ─────────── A. 라벨 계약 (항상 실행) ───────────

echo "== A. 강등 라벨 계약 =="
absent="$(node "$SP" --type factcheck --harness cc --tools "" 2>/dev/null)"
denied="$(node "$SP" --type factcheck --harness cc --tools Workflow,Task --denied 2>/dev/null)"
[ -n "$absent" ] && [ -n "$denied" ] || { echo "FAIL  spawn-plan 이 계획을 못 냈다 — 측정 자체가 안 됨"; exit 1; }

case "$absent" in
  *'parallelism=sequential'*) echo "PASS  강등 라벨 실재 — parallelism=sequential";;
  *) echo "FAIL  강등 라벨 부재 — 보고서에 격하가 안 적힌다"; fail=1;;
esac
case "$absent" in
  *'degraded=no-orchestration-tool'*) echo "PASS  부재 사유 라벨 실재";;
  *) echo "FAIL  부재 사유 라벨 부재"; fail=1;;
esac
case "$denied" in
  *'degraded=orchestration-denied'*) echo "PASS  거부 사유 라벨 실재";;
  *) echo "FAIL  거부 사유 라벨 부재 — 도구가 있는데 못 쓴 경우를 '없다'로 기록하게 된다"; fail=1;;
esac
# 두 사유가 실제로 갈리는가 — 한쪽이 다른 쪽을 덮으면 구분이 무의미하다.
case "$denied" in
  *'no-orchestration-tool'*) echo "FAIL  거부 계획에 부재 라벨이 섞였다 — 두 사유가 안 갈린다"; fail=1;;
  *) echo "PASS  두 사유 상호 배타";;
esac
# 부재를 거부로 위장하지 못한다(라벨 세탁 차단).
if node "$SP" --type factcheck --harness cc --denied >/dev/null 2>&1; then
  echo "FAIL  도구 없이 --denied 통과 — 부재를 거부로 위장할 수 있다"; fail=1
else
  echo "PASS  위장 차단 — 도구 없이 --denied = 비정상 종료"
fi

lbl() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log((JSON.parse(d).labels||[]).join(" "))}catch{console.log("(파싱 실패)")}})'; }
echo "관측 라벨(기대값 ❌) 부재: $(lbl "$absent")"
echo "관측 라벨(기대값 ❌) 거부: $(lbl "$denied")"

# ─────────── B. --bare 도구 부재 실측 (조건부) ───────────

echo "== B. --bare 도구 부재 실측 =="
skipped=0
if ! command -v "$CLI" >/dev/null 2>&1; then
  echo "SKIP  claude CLI 없음 (SKIP ≠ PASS)"; skipped=1
elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SKIP  ANTHROPIC_API_KEY 없음 — --bare 는 OAuth 를 읽지 않는다 (SKIP ≠ PASS)"; skipped=1
fi

if [ $skipped -eq 0 ]; then
  ver="$("$CLI" --version 2>/dev/null | awk '{print $1}')"
  [ "$ver" = "$BASELINE_CLI_VERSION" ] || \
    echo "WARN  CLI 버전 불일치 — baseline=$BASELINE_CLI_VERSION 관측=$ver (아래가 깨지면 여기부터 의심)"

  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  ( cd "$tmp" && "$CLI" -p "ok" --bare --output-format stream-json --verbose --max-turns 1 > init.jsonl 2>/dev/null )
  if [ ! -s "$tmp/init.jsonl" ]; then
    echo "FAIL  출력 없음 — 측정 자체가 안 됨(0 을 결과로 읽지 않는다)"; fail=1
  else
    tools="$(node -e '
      const fs=require("fs");
      for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === "system" && o.subtype === "init") { console.log((o.tools||[]).join(",")); break; }
      }' "$tmp/init.jsonl")"
    if [ -z "$tools" ]; then
      echo "FAIL  init 이벤트에 tools 부재 — 측정면이 사라졌다(계약 변경 의심)"; fail=1
    else
      echo "관측 도구: $tools"
      bad=0
      case ",$tools," in *,Workflow,*) echo "FAIL  --bare 에 Workflow 존재 — 이 fixture 의 전제(부재)가 깨졌다"; bad=1;; esac
      case ",$tools," in *,Task,*)     echo "FAIL  --bare 에 Task 존재 — 전제 깨짐"; bad=1;; esac
      [ $bad -eq 0 ] && echo "PASS  1·2단 동시 부재 확인 — 3단(순차) 강등이 실환경 경로임"
      fail=$((fail + bad))
    fi
  fi
fi

# exit 계약: 1=검사 실패 · 3=A는 통과했으나 B 미수행(부분) · 0=전건
[ $fail -ne 0 ] && exit 1
[ $skipped -ne 0 ] && { echo "결과: A 전건 통과 · B 미수행 = **부분**(SKIP ≠ PASS)"; exit 3; }
echo "결과: A·B 전건 통과"
exit 0
