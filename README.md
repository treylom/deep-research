# SearchFlow — 리서치 공정 (구 Deep Research)

소스 등급 가중 점수 + 은닉 문턱 게이트로 **깊이를 사후 결정**하는 리서치 공정.

깊이를 사용자에게 미리 묻지 않습니다. 쉬운 질의는 1라운드에서 문턱을 넘어 즉시 끝나고, 어려운 질의만 재조사를 돕니다 — **평균은 내려가고 하한은 올라갑니다.**

## 핵심 기능

- **깊이 자동 라우팅**: 질문 유형을 판정해 조사 프레임을 잡고, 점수가 문턱을 넘으면 조기 종료. 못 넘으면 **가장 약한 축만** 재조사(시한 1차 · 라운드 상한 2차)
- **소스 5등급**: **원Source · A급 · B급 · C급 · 사용불가** — 매체가 어디인지가 아니라 **"이 URL 이 그 주장에 대해 무엇인가"** 로 정합니다. 같은 신문이라도 원문을 그대로 실으면 원Source, 해설이면 C
- **원본 도달 의무**: B·C 를 근거로 쓸 때 원본 링크 추적 1회 시도, 실패 시 `원본 미도달` 라벨. **점수를 올리는 가장 싼 방법이 원본을 여는 것**이 되게 설계
- **차단 존중**: robots/ToS 로 막힌 곳은 우회하지 않고 `UNREACHABLE` 로 기록. **차단당한 것**과 **시한 내 못 쫓은 것**을 다른 값으로 구분
- **점수 은닉**: 등급·가중치·문턱은 리드만 봅니다. 워커 산출에는 그 필드가 없습니다 — 채점 대상이 채점 기준을 보면 그쪽으로 맞춰 씁니다
- **출처 원장**: 모든 소스를 `sources.jsonl` 로 기록(버린 것도 사유와 함께). 검사기가 스키마를 강제합니다

## 무의존 (중요)

**core 는 순정 Claude Code 또는 순정 Codex CLI + 이 번들만으로 완주합니다.** 외부 패키지·특정 플러그인 requirement 0. 환경에 도구가 더 있으면 얹어 쓰고, 없으면 **에러 없이 강등한 뒤 그 사실을 보고서에 라벨로 남깁니다**(조용한 skip 없음).

## 파일 구조

```
deep-research/                        # 저장소 이름은 아직 옛 이름입니다 (공정만 SearchFlow 로 교체)
├── commands/
│   ├── searchflow.md                 # /searchflow — 진입점
│   └── deep-research.md              # (deprecated) 구 호출용 얇은 리다이렉트
├── skills/
│   ├── searchflow/
│   │   ├── SKILL.md                  # 공정 정본
│   │   ├── references/               # 유형·프레임·취득·등급·합성·산출 계약
│   │   ├── scripts/                  # 검사기·게이트 (node, 외부 패키지 0)
│   │   └── fixtures/                 # 실측 기록·테스트 고정 입력
│   ├── deep-research-pipeline.md         # (deprecated) 구 7-Phase 엔진
│   └── deep-research-source-quality.md   # (deprecated) 구 A–E 등급
├── agents/
│   └── deep-researcher.md            # (deprecated) 구 워커 에이전트
├── tools/
│   └── publish-scan.mjs              # 공개 전 안전 스캔
├── CLAUDE.md
└── README.md
```

## 사용

| 하고 싶은 것 | 명령어 |
|------|--------|
| 질문 하나 조사 | `/searchflow 조사할 질문 또는 검증할 주장` |
| 인터랙티브 | `/searchflow` |

구 호출 `/deep-research` 도 그대로 동작합니다 — SearchFlow 공정으로 위임됩니다.

## 설치

CLAUDE.md 참조. **스크립트를 직접 실행하므로 `node` 가 필요합니다.**

## 선택 의존성

단독으로 동작하지만, 다음이 있으면 더 편합니다:

- [knowledge-manager](https://github.com/treylom/knowledge-manager): 콘텐츠 추출 + Obsidian 저장
- [prompt-engineering-skills](https://github.com/treylom/prompt-engineering-skills): 워커 프롬프트 최적화

## 레거시 (구 `/deep-research`)

구 7-Phase 파이프라인과 A–E 등급 체계는 **폐기**됐고, 문서는 예전 참조가 깨지지 않도록 남겨 뒀습니다(`skills/deep-research-*.md` · `agents/deep-researcher.md`). 새 작업에는 쓰지 마세요 — 특히 **A–E 등급과 현행 5등급은 기준 자체가 다릅니다**(전자는 매체 목록 기반, 후자는 주장 대비 URL 지위 기반).

## 라이선스

MIT
