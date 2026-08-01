---
name: deep-research
description: "[DEPRECATED — /searchflow 로 대체됨] 구 7-Phase 딥리서치 진입점. 호출은 /searchflow 로 위임됩니다."
argument-hint: <조사할 질문 또는 검증할 주장>
allowedTools: Agent, AskUserQuestion, Read, Write, Glob, Grep, WebSearch, WebFetch, Bash, Skill
---

# /deep-research — DEPRECATED

> **이 명령은 `/searchflow` 로 대체되었습니다.** 구 호출을 깨지 않기 위해 얇은 리다이렉트로만 존치합니다. 언제 지울지는 아직 정하지 않았고, **지울 때는 릴리스 노트로 먼저 알립니다.**

## 실행

`$ARGUMENTS` 를 **`/searchflow` 공정으로 그대로 위임**한다. 정본 = `skills/searchflow/SKILL.md`.

이 파일에는 실행 로직을 두지 않는다 — 두 진입점이 각자 공정을 갖는 순간 둘이 어긋나기 시작한다.

사용자에게 1줄 고지한 뒤 진행한다:

> `/deep-research` 는 `/searchflow` 로 이름이 바뀌었습니다. 이번 조사는 SearchFlow 공정으로 진행합니다.

## 무엇이 달라졌나

| 축 | 구 `/deep-research` | 신 `/searchflow` |
|---|---|---|
| 소스 등급 | **도메인 화이트리스트** 기반 A–E (tier 목록 매칭) | **"이 URL 이 그 주장에 대해 무엇인가"** 기반 5등급 `ORIGINAL\|A\|B\|C\|UNREACHABLE` — 같은 매체라도 원문을 실으면 원Source, 해설이면 C |
| 깊이 | 사용자가 사전 선택 | **시스템 자동 라우팅** + 문턱 통과 시 조기 종료 |
| 재조사 | 고정 Phase 수 | **최저 축만** 재조사, 시한 1차 · 라운드 상한 2차 |
| 점수 | 워커가 등급 판정 | **등급·가중치·문턱은 리드 전용**(워커 비가시) |
| 의존 | 팀 도구·다수 스킬 참조 | **core 는 순정 CLI + 번들만으로 완주** |

## 기존 run 원장 처분 (read-only)

**구 `/deep-research` 가 남긴 run 원장(`id/title/author/date/claims` · D/E 등급 포함)은 read-only 로 보존한다.**

- **변환하지 않는다.** 구 데이터 무손실 보존 + 이중 계약 회피가 변환 이득보다 크다.
- **신규 run 만 `sources.jsonl` schema v1** 로 기록된다(`skills/searchflow/scripts/grade-ledger.mjs` 검증 대상).
- **구 run 의 재개(resume)는 미지원.** 이어서 하려면 신규 run 으로 재실행한다.
- 구 등급 `D`/`E` 는 신 5등급에 대응 항목이 없다 — 신 원장에 그대로 넣으면 `grade` enum 위반으로 잡힌다(의도된 차단).

## 구 참조 파일

`skills/deep-research-pipeline.md` · `skills/deep-research-source-quality.md` · `agents/deep-researcher.md` 는 이력·대조용으로 남아 있으며 **신 공정의 실행 경로에는 없다.**
