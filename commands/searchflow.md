---
description: SearchFlow — 소스 등급 가중 점수 + 은닉 문턱 게이트로 깊이를 사후 결정하는 리서치 공정 (구 /deep-research)
argument-hint: <조사할 질문 또는 검증할 주장>
---

# /searchflow

`$ARGUMENTS` 를 조사한다.

## 실행

`skills/searchflow/SKILL.md` 를 정본으로 그 공정을 따른다. 요지:

1. **P0 스코핑** — 유형 판정(8종 + 복합, `references/frames.md`) → 프레임 축 확정 → 깊이 자동 라우팅 → **묶음 질문 1회(마감 시한 포함)** → 권한 preflight → `run_id` 발급
2. **P1 스폰** — 프레임 축마다 조사 단위 1개 (하네스별 분기 = SKILL.md §3)
3. **P2 수집** — 워커는 근거 + `SELF-REPORT`(Y/N + 근거 1줄)만 반환. **등급 부여 ❌**
4. **P3 채점** — 리드가 등급 부여 → `out/sources.jsonl` 기록(single-writer) → 축별 채점 → 문턱 대조
5. **P4 게이트** — 통과 시 종료 / 미달 시 **최저 축만** 재조사, 최대 2라운드

## 시작 시 1회

```bash
node skills/searchflow/scripts/env-detect.mjs        # exit 항상 0, stdout 1줄 JSON
```

결과는 **리드만 소비한다.** enhanced 부재 = 에러가 아니라 core 강등 + 보고서 격하 라벨.
`multi_agent_api` 는 참고값이며 multi-agent 경로의 최종 판정은 리드가 자기 tool 목록으로 한다.

## 산출

- `out/report.md` — `references/report-contract.md` 칸 목록 전건
- `out/sources.jsonl` — schema v1

기록 후 검증:

```bash
node skills/searchflow/scripts/grade-ledger.mjs out/sources.jsonl
# exit 0=PASS · 1=위반(수리) · 2=스크립트 오류(통과 취급 ❌ — 사유 기록 후 core 진행)
```

## 하지 말 것

- 사용자에게 **깊이를 고르게 하지 말 것** — 시스템이 라우팅한다(SKILL.md §2)
- 워커 프롬프트에 **점수·가중치·문턱을 넣지 말 것** — 재조사 지시는 "이 축이 약하다"까지
- `robots.txt`/ToS/페이월/CAPTCHA **우회 금지** — 미도달로 기록(`references/acquisition.md` §2)
- 원장을 **워커가 append 하지 말 것** — 리드 single-writer

## 구 `/deep-research` 사용자

구 명령은 이 명령으로 위임되는 얇은 리다이렉트로 존치한다. **기존 run 원장은 read-only 로 보존**되며 신규 run 만 schema v1 로 기록된다 — 구 데이터를 변환하지 않는다(무손실 보존 + 이중 계약 회피). 기존 run 의 재개(resume)는 지원하지 않으니 신규 run 으로 재실행한다.
