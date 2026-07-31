#!/usr/bin/env bash
# S2 스모크 — tier 1(Workflow) 팬아웃이 실제로 워커 계약을 돌려주는가
#
# 재는 것 : 조립된 워커 프롬프트 2개 → 병렬 팬아웃 → 각 워커가 계약 JSON 반환
#            (frame_id · findings[] 필수 4키 · self_report S1~S5 · **grade 칸 부재**)
# 재지 않는 것 : 보고서 합성·원장 병합 → S3 소관. **그래서 이것은 AC8 '완주'가 아니다.**
#            둘을 같은 이름으로 부르면 S3 없이 완주했다는 오귀속이 생긴다.
#
# 선행 조건: 인증된 CLI. 격리 프로필은 인증을 승계하지 못하므로(실측) 이 스모크는
#            기본 프로필에서 돌리고 MCP·프로젝트 문맥만 차단한다 = **부분 격리**.
#            보고 시 격리 등급을 그렇게 적는다(격리했다고 믿는 미격리를 만들지 않는다).
#
#   BASELINE_CLI_VERSION = 2.1.220 · BASELINE_OBSERVED_AT = 2026-07-31 (KST)
#   BASELINE_RESULT      = Workflow 호출 1회 · 워커 2/2 계약 PASS · 약 40s
set -u

SF="${SEARCHFLOW_SKILL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="${SEARCHFLOW_CLAUDE_BIN:-claude}"
command -v "$CLI" >/dev/null 2>&1 || { echo "SKIP  claude CLI 없음 (SKIP ≠ PASS)"; exit 3; }

OUT="$(mktemp -d)"; mkdir -p "$OUT/cwd"
echo "작업 디렉터리: $OUT"

# 축 정의는 spawn-plan(→ frames.md 유일 SoT)에서 가져온다 — 축 문장을 여기 손으로 적지 않는다.
node "$SF/scripts/spawn-plan.mjs" --type factcheck --harness cc --tools Workflow > "$OUT/plan.json" || exit 2
F2_AXIS="$(node -e 'console.log(require(process.argv[1]).units[1].axis)' "$OUT/plan.json")"

# 검사 통과분(f3 조립 샘플)을 베이스로 f2 판을 만든다 — 축 줄만 치환(문장 추가 ❌ = SKILL.md §P2.5).
cp "$SF/fixtures/worker-prompt-sample.txt" "$OUT/w-f3.txt"
sed -e "s|^담당 축: f3 —.*|담당 축: f2 — ${F2_AXIS}|" -e 's|"frame_id": "f3"|"frame_id": "f2"|' \
    "$SF/fixtures/worker-prompt-sample.txt" > "$OUT/w-f2.txt"

# 스폰 전 은닉 검사 — 조립물이 통과해야 스폰한다.
node "$SF/scripts/hide-check.mjs" "$OUT/w-f2.txt" "$OUT/w-f3.txt" || { echo "ABORT  누출 검사 실패 — 프롬프트를 수리하고 다시(패턴 좁히기 ❌)"; exit 1; }

cat > "$OUT/lead.txt" <<PROMPT
You are the SearchFlow lead. Do exactly this and nothing else.

Call the Workflow tool ONCE with this script:

export const meta = { name: "sf-s2-spawn-smoke", description: "S2 tier-1 fanout contract smoke", phases: [{ title: "Fanout" }] }
phase("Fanout")
const prompts = [{id: "f2", file: "$OUT/w-f2.txt"}, {id: "f3", file: "$OUT/w-f3.txt"}]
const res = await parallel(prompts.map(p => () =>
  agent(\`Read the file \${p.file} and follow it exactly. It is your complete instruction set. Return ONLY the JSON it asks for, no prose, no code fences.\`, {label: \`worker:\${p.id}\`, phase: "Fanout"})
))
return { res }

After it returns, output the two worker JSON objects verbatim, separated by a line containing only ---SPLIT---. Output nothing else.
PROMPT

cd "$OUT/cwd" || exit 2
"$CLI" -p "$(cat "$OUT/lead.txt")" --output-format stream-json --verbose \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --permission-mode bypassPermissions --max-turns 20 > "$OUT/run.jsonl" 2> "$OUT/run.err"

node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
let res=null; const uses=[];
for (const l of lines) { let o; try { o=JSON.parse(l); } catch { continue; }
  if (o.type==="result") res=o;
  const c=o?.message?.content; if (Array.isArray(c)) for (const b of c) if (b.type==="tool_use") uses.push(b.name); }
const fanout = uses.includes("Workflow");
console.log((fanout?"PASS":"FAIL")+"  tier 1 팬아웃 호출 — tool_use="+(uses.join(",")||"(없음)"));
console.log("       is_error="+res?.is_error+" ms="+res?.duration_ms);
const parts=String(res?.result||"").split(/^---SPLIT---$/m);
let ok=0;
for (const p of parts) {
  const s=p.indexOf("{"), e=p.lastIndexOf("}"); if (s<0||e<0) continue;
  let o; try { o=JSON.parse(p.slice(s,e+1)); } catch { continue; }
  const sr=o.self_report||{};
  const axes=["S1","S2","S3","S4","S5"].filter(k=>sr[k]&&typeof sr[k].y==="boolean"&&typeof sr[k].why==="string");
  const fOk=(o.findings||[]).length>0 && o.findings.every(f=>f.url&&f.claim&&f.verbatim&&f.accessed_at);
  const grade=/"grade"/.test(JSON.stringify(o));
  const pass = !!o.frame_id && fOk && axes.length===5 && !grade;
  if (pass) ok++;
  console.log(`       frame_id=${o.frame_id} findings=${(o.findings||[]).length} self_report=${axes.length}/5 grade칸=${grade?"🔴있음":"없음"} → ${pass?"PASS":"FAIL"}`);
}
console.log((ok===2?"PASS":"FAIL")+"  워커 계약 "+ok+"/2");
// 음성 대조 — 두 산출이 같은 문자열이면 병렬이 아니라 복제다.
const same = parts.length>1 && parts[0].trim()===parts[1].trim();
console.log((same?"FAIL":"PASS")+"  음성 대조 — 두 워커 산출 상이(동일이면 복제·캐시 의심)");
process.exit((fanout && ok===2 && !same) ? 0 : 1);
' "$OUT/run.jsonl"
rc=$?
echo "artifacts=$OUT"
exit $rc
