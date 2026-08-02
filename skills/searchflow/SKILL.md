---
name: searchflow
description: Use when a research question needs sourced, cross-checked findings — fact-checks, market/company/tech/policy research, comparisons, or open exploration. Routes the question to a research type, spawns per-frame investigators, grades sources, and re-investigates the weakest axis until a deadline or round cap. Replaces /deep-research.
---

# SearchFlow

**소스 등급 가중 점수 + 은닉 문턱 게이트로 깊이를 사후 결정하는 리서치 공정.**

깊이를 사용자에게 미리 묻지 않는다. 쉬운 질의는 1라운드에서 문턱을 넘어 즉시 끝나고, 어려운 질의만 재조사를 돈다 — 평균은 내려가고 하한은 올라간다.

## 0. 두 층

- **core (기본)**: 순정 Claude Code 또는 순정 Codex CLI + 이 스킬 번들만으로 완주한다. 외부 패키지 · 내부 MCP · 특정 플러그인 requirement **0**.
- **enhanced (선택)**: 환경에 있으면 얹는다. 없으면 **에러 없이 core 로 강등하고 격하 라벨을 보고서에 남긴다** — 조용한 skip 금지.

`scripts/env-detect.mjs` 를 시작 시 1회 실행해 참고값을 얻는다(인자 없이 호출 = exit 0 고정, stdout 1줄 JSON). **탐지 결과는 리드만 소비한다.**

> ⚠️ `multi_agent_api` 값은 참고다. **multi-agent 경로의 최종 판정은 리드가 자기 tool 목록을 보고 한다** — shell 스크립트가 모델의 tool 노출을 대신 판정하면 틀린다.

### 0-1. 공정 소유권 — 스킬이 쥐나, 서버가 쥐나

위 두 층과 **직교하는 축**이다(core/enhanced = 어떤 도구를 얹나 · 아래 = 누가 공정을 강제하나).

| 모드 | 조건 | 채점 기준이 사는 곳 | 판정 |
|---|---|---|---|
| **skill-owned (기본)** | `searchflow_*` 도구가 tool surface 에 **없다** | `references/scoring.md` — 리드가 읽고 리드가 채점 | 리드 |
| **server-owned** | `searchflow_start`·`searchflow_submit`·`searchflow_gate` 가 tool surface 에 **있다** | MCP 서버 내부(파일로 존재하지 않음) | 서버 |

- **판정 주체 = 리드가 자기 tool 목록을 보고 한다.** 위 `multi_agent_api` 주의와 같은 이유로 shell 이 대신 판정하지 않는다. 서버가 안 떠 있으면 도구가 애초에 안 보이므로 **탐지 실패 = skill-owned 로 fail-open**(에러 ❌).
- server-owned 면 리드는 **`scoring.md` 를 열지 않는다.** 프레임·브리핑·판정을 전부 서버에서 받고, 서버가 준 `worker_brief` 를 **그대로** 워커에게 넘긴다(문장을 늘리지 않는다 — §P2.5 와 같은 이유).
- 어느 쪽이든 **보고서에 모드를 적는다**: `process_owner: skill | server`. 조용한 전환 금지 — 같은 질의가 다른 깊이로 끝났을 때 원인이 모드였는지 알 수 있어야 한다.

> ⚠️ 이 표는 **2026-08-02 신설**이다. 그전까지 서버는 존재했지만 스킬이 그 존재를 몰랐다 — 즉 「2모드」가 설계 문서에만 있고 실행 경로엔 없었다. 두 모드를 비교하려면 먼저 모드가 있어야 한다.

## 1. 공정 (P0 → P4)

```
P0 스코핑 ── 유형 판정 → 프레임 확정 → 깊이 라우팅 → 묶음 질문 1회(마감 시한 포함) → 권한 preflight
P1 스폰   ── 프레임 축마다 조사 단위 1개 (하네스별 분기 §3)
P2 수집   ── 워커: 근거 + SELF-REPORT(Y/N + 근거 1줄)만 반환. 등급 부여 ❌
P3 채점   ── 리드: 소스 등급 부여 → 원장 기록 → 축별 채점 → 문턱 대조   ← 리드 전용
P4 게이트 ── 문턱 통과 → 종료 / 미달 → 최저 축만 재조사(P1 로) → 최대 2라운드
```

### P0 — 스코핑

1. **유형 판정** — `references/frames.md` §1 판정표. 복합 허용, 실패 시 `discovery` 폴백.
2. **프레임 확정** — 같은 파일 §2 표에서 축 목록을 가져오고, 복합이면 §1 결합 규칙으로 접는다. 축 id = `f1`…`fN`.
3. **깊이 자동 라우팅** — 아래 §2 표. 사용자에게 깊이를 고르게 하지 않는다.
4. **묶음 질문 1회** — §4.
5. **권한 preflight** — §5.
6. **run_id 발급** — `sf-<YYYYMMDDTHHMMSSZ>-<4hex>`, 이후 모든 원장 라인·relay envelope 에 동일 값.

### P1 — 취득 (사다리 + 차단 게이트)

`references/acquisition.md` 의 사다리를 위에서부터, 같은 단 안에서는 최신 발행분부터(§1). **취득 시도 전에 차단 여부를 기계로 판정한다**:

```bash
node scripts/robots-gate.mjs <대상 URL> [...]
# exit 0=전건 allowed · 1=1건 이상 blocked(**정상 결과다 — 재시도·우회 신호 아님**) · 2=스크립트 오류
# blocked 면 stdout 의 `ledger` 를 그대로 sources.jsonl 에 넣는다(grade=UNREACHABLE·status=unreachable)
```

- 판정은 **적용 가능한 User-agent 그룹 중 가장 엄한 것**이다. `*` 만 보면 안 된다 — 발행처가 `*` 는 열어두고 **AI 엔진 계열 이름에만 전면 불허**를 거는 경우가 실재한다(`fixtures/blocked-observed.md` 실측). `--ua-only "*"` 로 완화 가능하지만 기본값을 바꾸지 말 것.
- `tos_notice` 가 붙으면 robots.txt **주석에 이용 제한 문구**가 있다는 뜻이다. 기계 판정 밖이므로 리드가 원문을 읽고 판단한다 — "파싱 못 했으니 없음"으로 넘기면 하드 게이트의 ToS 축이 조용히 사라진다.
- **로그인 · 페이월 · CAPTCHA 는 이 스크립트로 판정 불가**하다. 취득 시도 중 관측해 같은 형식으로 원장에 적는다.

### P2 — 워커 계약 (은닉의 실체)

워커에게 주는 것: 담당 축 1개 · 질의 · 취득 사다리(`references/acquisition.md`) · 반환 형식.
워커에게 **주지 않는 것**: 등급 점수 · 축 가중치 · 합격 문턱 · 다른 축의 산출.

워커 반환:

```json
{ "frame_id": "f3", "findings": [ { "url": "...", "claim": "...", "verbatim": "...", "accessed_at": "..." } ],
  "self_report": { "S1": {"y": true, "why": "..."}, "S2": {...}, "S3": {...}, "S4": {...}, "S5": {...} } }
```

`grade` 필드는 **워커 산출에 없다.** 등급은 리드가 부여한다.

**재조사 지시문은 "이 축이 약하다"까지만 쓴다** — 점수·문턱·목표치를 적지 않는다. 문턱을 아는 조사자는 문턱을 향해 최적화한다(원본을 찾는 것보다 원본이라고 주장하는 게 싸다).

### P2.5 — 워커 프롬프트 조립 (은닉의 구현 = 파일 경계)

**조립 입력은 다음 3개뿐이다.** `references/scoring.md` 는 **입력 목록에 없다** — 그 파일을 열지 않는 것이 은닉의 전부이고, 접근 통제나 주의력에 의존하지 않는다.

| 조립 입력 | 무엇 |
|---|---|
| 사용자 질의 + P0 답변 | 조사 대상·마감 |
| `references/frames.md` | 담당 축 1개의 정의 |
| `references/acquisition.md` | 취득 사다리·하드 게이트 |

아래 템플릿을 그대로 채워 쓴다. `{}` 만 치환하고 문장을 늘리지 않는다 — 늘어난 문장이 수치를 실어 나른다.

```text
질의: {질의}
담당 축: {frame_id} — {축 이름}: {frames.md 의 축 정의 1줄}
당신은 이 축만 조사한다. 다른 축은 다른 조사자가 맡고 있고, 그쪽 산출은 보지 않는다.

취득: references/acquisition.md 의 사다리를 위에서부터 시도한다.
  탐색 순서: 최신 발행분부터 연다. 오래된 자료도 근거가 되지만, 더 최신의 정정·후속을 확인하기 전까지
  결론으로 굳히지 않고 확인 여부를 findings 의 claim 에 1줄 적는다.
  robots.txt·ToS·페이월·CAPTCHA 는 우회하지 않는다 — 미도달로 기록한다.
  2차 자료를 근거로 쓸 때는 원본 링크 추적을 1회 시도하고, 실패하면 "원본 미도달"이라 적는다.

반환(JSON):
{
  "frame_id": "{frame_id}",
  "findings": [ { "url": "", "claim": "", "verbatim": "", "accessed_at": "" } ],
  "self_report": {
    "S1": {"y": true|false, "why": "근거 1줄"},
    "S2": {"y": true|false, "why": "근거 1줄"},
    "S3": {"y": true|false, "why": "근거 1줄"},
    "S4": {"y": true|false, "why": "근거 1줄"},
    "S5": {"y": true|false, "why": "근거 1줄"}
  }
}

S1 근거강도 / S2 교차검증 / S3 반증탐색 / S4 신선도 / S5 공백선언 — 각 Y/N + 근거 1줄.
findings 에 등급 칸은 없다. 등급은 당신이 매기지 않는다.
원장 파일에 직접 쓰지 않는다 — 산출을 반환하면 병합은 리드가 한다.

마감: {마감 시각}. 도달하면 그 시점 산출을 그대로 반환한다(미완도 반환).
```

**재조사 라운드 추가문** (이것 외의 문장을 붙이지 않는다):

```text
재조사: {축 이름} 이 약하다. {약한 이유를 관측 사실로만 1줄 — 예: "독립 경로가 하나뿐이다" / "반대 증거를 찾지 못했다"}
{한 문장 지시 — 예: "독립 경로를 하나 더 찾아라" / "반대 증거를 찾아라"}
```

조립 후 검사:

```bash
node scripts/hide-check.mjs <조립된 프롬프트 파일>...
# 0=PASS · 1=누출 또는 검사기 사망 · 2=스크립트 오류(통과 취급 ❌)
```

> ⚠️ 검사 대상은 **조립 결과물**이다. 이 SKILL.md 나 `scoring.md` 를 대상으로 넘기면 당연히 걸린다 — 그건 리드 전용 층이라 걸리는 것이 정상이다.
>
> exit 1 이 나면 프롬프트를 **수리한 뒤** 스폰한다. 패턴을 좁혀서 통과시키지 않는다(패턴을 좁히면 은닉이 함께 얇아진다).

### P3/P4 — 리드 전용

등급 기준 · 축 가중치 · 문턱은 **`references/scoring.md`(🔒 리드 전용)** 에 있다. 이 파일과 `references/frames.md` · `acquisition.md` · `report-contract.md` 에는 그 수치가 없다 — 워커 프롬프트가 이 경로만 밟도록 조립하기 때문이다(§P2.5).

⚠️ `scoring.md` 의 등급 점수·가중치·문턱은 **전부 잠정값**이다. census held-out 검증(구현 S4 단계) 전에는 고정하지 않으며, 실측처럼 인용하지 않는다.

원장 기록은 **single-writer**: `sources.jsonl` append 는 리드 프로세스만 한다. 워커는 자기 산출을 개별 파일로 반환하고 리드가 병합 기록한다(JSONL 동시 append 경쟁을 설계에서 제거).

기록 후 `node scripts/grade-ledger.mjs <경로>` 로 스키마를 검증한다. exit `1`=위반 수리, exit `2`=스크립트 오류이며 **통과 취급하지 않는다**(사유 기록 후 core 진행).

## 2. 깊이 자동 라우팅

| 신호 | 스폰 폭 | 라운드 예산 | 시한 추천 |
|---|---|---|---|
| 단일 주장 · 단일 유형 (`factcheck` 등) | 프레임 표 그대로 | 1 (문턱 통과 시 즉시 종료) | 10분 |
| 복합 2유형 · 비교 | 접은 축 전부 | 최대 2 | 20분 |
| 복합 3유형+ · `discovery` 광범위 | 접은 축 전부 (상한 6) | 최대 2 | 30분 |

시한은 **추천값**이며 P0 묶음 질문에서 사용자가 덮어쓸 수 있다. 라운드 상한 2는 덮어쓸 수 없다.

## 3. 하네스 분기 — 조사 단위 스폰

### Claude Code (3단 폴백)

| 순위 | 경로 | 조건 | tier 라벨 |
|---|---|---|---|
| 1 | **`Workflow` 도구** — 축별 워커를 한 스크립트로 팬아웃 | 리드 자기 tool surface 에 `Workflow` 노출 | `cc-workflow` |
| 2 | **서브에이전트**(`Task`/`Agent` — 읽기 전용 조사) 축별 병렬 | 1단 부재, `Task` 또는 `Agent` 노출 | `cc-subagent` |
| 3 | **순차 실행** + 격하 라벨 | 둘 다 부재 | `sequential` |

🔴 **1단 도구 이름을 여기 적어두는 것 자체가 배선이다.** 하네스가 병렬 도구에 *사용자 명시 opt-in* 을 요구하는 경우, 그 조건 중 하나가 **"스킬의 지시가 그 도구를 부르라고 할 때"** 다. 이름을 안 적으면 도구가 있어도 리드가 자제해 2단으로 내려가고, **그 강등은 라벨 없이 일어난다**(성능은 떨어지는데 보고서에는 흔적이 없다). 그래서 1단은 이름으로 지목한다.

**부재 판정은 리드가 자기 tool surface 로 한다.** `env-detect.mjs` 의 값은 참고용이다 — shell 프로세스는 모델의 도구 노출을 대신 판정할 수 없다.

> 실측 참고(2026-07, CLI 2.1.220 · headless): 플러그인·설정·MCP 전부 0인 프로필에서도 `Workflow` 는 기본 도구 목록에 있었고 실호출도 됐다. 즉 3단 폴백의 1단은 통상 실재한다. 반면 CLI 의 **최소 모드(`--bare`)에는 1·2단이 동시에 없었다** — 3단은 이론적 바닥이 아니라 실재 경로다(`fixtures/ac9-degrade-bare.sh`). 버전 의존일 수 있으므로 그 fixture 는 버전 스탬프를 들고 있다.

### Codex CLI (capability adapter)

| 순위 | 경로 | 조건 | 층 |
|---|---|---|---|
| 1 | 공개 `multi_agent` API (spawn / send-or-resume / wait) | tool surface 에 노출 | **core** |
| 2 | `collab_v2` (spawn_agent / send_message / `followup_task` / wait_agent) | v2 namespace 노출 시 | enhanced |
| 3 | 순차 실행 (같은 프레임 목록) + `parallelism=sequential` 라벨 | 어느 multi-agent API 도 없음 | core 폴백 |

**goal**: top-level 1개(조사 전체 대표) + 리드가 task DAG 를 든다. goal 트리(하위 goal) 는 만들지 않는다.
- thread 에 이미 active goal 이 있으면 **새 goal 생성을 시도하지 않고** task DAG 만으로 진행 + `goal=skipped-collision` 라벨.
- run 종료 시 goal 을 **close/complete 로 명시 종결**한다. 방치된 goal 이 다음 run 의 충돌 원인이 된다.

**순차 강등은 프레임을 합치지 않는다.** 특히 `factcheck` 의 지지/반증 축은 순차에서도 별개 조사 단위로 유지한다(편향 차단 장치 — `frames.md` §2).

### 경로 등가 — 기계로 강제한다

tier 는 **실행 방식과 라벨만** 바꾼다. 조사 단위 집합은 어느 tier 에서도 같아야 한다. 눈으로 지키지 않고 스크립트로 고정한다:

```bash
node scripts/spawn-plan.mjs --type <유형[,유형2]> --harness cc --tools "<리드가 실제로 보는 도구 이름들>"
node scripts/spawn-plan.mjs --type <유형>          --harness codex --multi-agent-api public|collab_v2|none
# stdout: {"harness":…,"tier":…,"parallelism":…,"units":[{frame_id,type,axis}…],"labels":[…],"dedupe_required":bool}
# exit 0=계획 · 1=입력 계약 위반 · 2=스크립트 오류(통과 취급 ❌)
node scripts/spawn-plan.mjs --test   # 경로 등가·순차 분리 유지·상한·폴백·음성 대조
```

- 유형→축 표의 **유일 SoT 는 `references/frames.md` §2** 다. 스크립트는 그것을 파싱한다 — 표를 코드에 복제하지 않는다(이중 관리는 한쪽만 갱신되는 순간 조용히 갈린다).
- `dedupe_required:true` = 복합 유형이다. **의미적 중복 접기는 기계가 못 한다** → 리드가 `frames.md` §1 결합규칙 2 를 적용하고, 접은 축을 「관찰 범위 선언」에 적는다.
- `labels` 를 보고서 「환경·한계」 칸에 **그 문자열 그대로** 옮긴다. 문자열이 바뀌면 격하 여부를 기계로 확인할 수 없게 된다.

## 4. 질문 주체 = 리드 일괄

**스폰 전에 리드가 유형별 템플릿으로 1회 묶음 질문**을 한다. 축마다 따로 묻지 않는다 — 병렬 조사자들이 각자 사용자에게 물으면 사용자가 동시에 여러 질문을 받고 전원이 답까지 블록된다.

묶음 질문에 **반드시 포함**: 마감 시한(1차 종료 조건).

채널: CC = 대화형 질문 도구 / Codex = 리드가 사용자에게 묻고 답을 워커에 주입.

### 스폰 후 새 질문 (blocked node)

워커가 조사 중 새 질문을 발신하면:

1. 리드가 **중복 제거**
2. **라운드 경계에서 묶음 질문 최대 1회/라운드**
3. 답 대기 중 **다른 프레임은 독립 진행**
4. 답 수신 시 §3 경로로 주입해 재개

**relay envelope**: `{run_id, frame_id, question_id, round, status}` — `status` 전이 = `pending → asked → answered → resumed`, 각 전이는 리드만 기록. 기록 위치 = `out/relay.jsonl`(리드 single-writer, 원장과 같은 규율).

```bash
node scripts/relay-check.mjs out/relay.jsonl
# stdout: {run_id,records,questions,frames,efup:[…],in_flight:[…],violations:[…]}
# exit 0=위반 0 · 1=위반(빈 원장 포함 — 0건은 통과가 아니다) · 2=스크립트 오류
node scripts/relay-check.mjs --test   # 양성 + 음성 5종 + exit 계약
```

**완료 워커 재진입(E-FUP)**: 어떤 축의 라운드 1 주기가 `resumed` 까지 끝난 뒤 그 축에 라운드 2 질문이 열리면, 리드는 그 워커를 **재스폰하지 않고 재진입**시킨다(`collab_v2` 는 `followup_task`). 재스폰하면 라운드 1에서 이미 읽은 것을 다시 읽는다. `relay-check` 의 `efup` 배열이 원장에 그 형태가 남았는지 확인한다.
⚠️ 그 검사는 **원장의 형태**를 재는 것이고 런타임이 실제로 재진입했는지를 재는 것이 아니다 — GREEN 을 "재진입이 동작한다"로 인용하지 않는다.

### 비대화 실행 (질문 채널 없음)

`codex exec` 류로 질문할 수 없으면 **기본값을 채택**한다: 시한 = 시작 + 30분 · 라운드 상한 2. 보고서 「환경·한계」에 `deadline=default` 라벨.

## 5. 권한 preflight (시작 시 1회)

| 거부된 권한 | 처분 |
|---|---|
| `web` | **hard stop** — 리서치 불능. 사유 보고 후 종료 |
| `shell` | degrade — 스크립트 검증 skip + 라벨 |
| `agent` · `goal` | 순차 강등 |

**거부(permission)와 부재(dependency)를 라벨에서 구분한다.** "도구가 없다"와 "도구를 못 쓰게 했다"는 다른 사실이다. 산문으로만 구분하지 말고 **기계 라벨에서 갈라라** — 순차 강등 시 사유를 골라 넣는다:

| 사유 | 호출 | 라벨 |
|---|---|---|
| **부재** — 이 환경에 오케스트레이션 도구가 없다 | `spawn-plan.mjs --type <t>` (도구 목록에 없음) | `degraded=no-orchestration-tool` |
| **거부** — 도구는 실재하나 정책·권한이 호출을 막는다 | `spawn-plan.mjs --type <t> --tools Workflow,Task --denied` | `degraded=orchestration-denied` |

`--tools` 에는 **실제 보이는 도구를 사실대로** 적고 거부는 `--denied` 로 선언한다. 도구를 목록에서 빼서 순차로 내려가면 라벨이 "없다"고 **거짓 주장**한다. 반대 세탁도 막혀 있다 — 도구 없이 `--denied` 는 exit 1 이다.

> 이 갈림은 실측에서 나왔다(AC8 RUN1, 2026-07-31): 세션에 `Workflow`·`Agent` 가 실재했는데 정책이 호출을 금지해 순차로 갔고, 그때 기계 라벨은 부재를 주장했다. 리드가 본문에 사유를 따로 적어 살렸지만 **기계 대조로는 잡히지 않는 거짓말**이었다.

## 6. 에러 매트릭스

| 상태 | 처분 |
|---|---|
| `success` | 정상 종료 |
| `deadline` | 시한 도달 — **현재 산출을 조건부 반환**(점수 · 미충족 축 · 사유 명시) |
| `cancel` | 사용자 중단 — 원장·부분 산출 보존 |
| `agent-denied` | 해당 프레임 순차 강등. 전 프레임 거부면 전체 순차 |
| `goal-collision` | goal 없이 task DAG 진행 + 라벨 |
| `worker-error` | 그 프레임 순차 재시도 1회 → 실패 시 **프레임 결측 라벨**로 계속 |
| `malformed-relay` | envelope 키 결손·파싱 불가 = 그 질문 폐기 + 라벨, 워커는 기본값으로 진행 |

## 7. 종료 조건

1. **1차 = 사용자 마감 시한** (P0 에서 물은 값, 비대화면 기본 30분)
2. **2차 = 라운드 상한 2회**

시한 도달 = 실패가 아니다. **현재 산출을 조건부로 반환**하고 「종료 조건 성적표」 칸에 어디서 멈췄는지 적는다. 미달인 채로 정직하게 보고하는 것이 무한 재조사보다 싸고 정직하다.

## 8. 산출

- `out/report.md` — `references/report-contract.md` 의 칸 목록 전건. 합성 배열은 `references/synthesis.md`
  (유형별 템플릿·판정표 스켈레톤). **템플릿이 조사를 늘리지 않는다** — 빈 칸은 「공백 선언」으로.

```bash
node scripts/report-check.mjs out/report.md --labels "$(node scripts/spawn-plan.mjs --type <유형> --harness cc --tools "<도구>" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).labels.join(",")))')"
# 칸 목록 SoT = report-contract.md §1 파싱(복제 ❌) · 라벨은 spawn-plan 이 낸 문자열 그대로
# exit 0=위반 0 · 1=칸 부재/제목만/라벨 부재 · 2=스크립트 오류
node scripts/report-check.mjs --test   # 양성 0 / 음성 3종 대조
```

> 이 검사기는 **칸이 있고 비어있지 않은가**만 본다. 내용의 진위·인용 일치·점수 계산은 보지 않는다 — GREEN 을 "보고서가 옳다"로 인용하지 말 것.
- `out/sources.jsonl` — schema v1 (리드 single-writer, `grade-ledger.mjs` 통과)
- `out/relay.jsonl` — 사용자 질문 릴레이 원장 (리드 single-writer, `relay-check.mjs` 통과). 질문이 0건이었으면 이 파일은 만들지 않는다 — **빈 파일을 남기지 않는다**(검사기가 빈 원장을 위반으로 잡는다).

## 9. 공개 안전

내부 절대경로 · 봇 이름 · 스레드 id · 개인 식별정보를 산출물에 넣지 않는다. `person` 유형은 공개 직무 사실만(`frames.md` §1 특칙). **점수는 공개하되 가중치는 비공개**(`report-contract.md` §3).
