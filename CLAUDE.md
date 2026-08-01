# SearchFlow

리서치 공정. 진입점은 **`/searchflow`** 입니다. 개요는 README.md 를 보세요.

## 필요한 것

- **Claude Code** 또는 **Codex CLI** (둘 중 하나)
- **`node`** — 검사기 스크립트를 직접 실행합니다. 표준 내장 모듈만 쓰고 **외부 패키지는 설치하지 않습니다**(실측 환경 = v24.14.1)

## 설치

```bash
# 저장소 안에서 실행합니다.
# ⚠️ 폴더 이름을 그대로 주지 마세요 — `cp -r skills ~/.claude/skills/` 처럼 쓰면
#    대상 안에 `skills/skills/` 로 한 겹 더 들어갑니다. 끝에 `/*` 를 붙이면 안전합니다.
#    (macOS `/bin/cp` 실측: `skills/*`·`skills/` 는 안 들어가고, `skills` 만 들어갑니다.
#     GNU cp 는 미확인 — 확실한 `/*` 형태를 씁니다.)
mkdir -p ~/.claude/skills ~/.claude/commands ~/.claude/agents
cp -r skills/*   ~/.claude/skills/
cp -r commands/* ~/.claude/commands/
cp -r agents/*   ~/.claude/agents/
```

`skills/searchflow/` 는 **폴더 통째로** 옮겨져야 합니다. 안에 `scripts/`(검사기)와 `references/`(공정 세부)가 들어 있고, 공정이 실행 중에 이 둘을 직접 읽습니다. `SKILL.md` 한 장만 복사하면 동작하지 않습니다.

### 설치 확인 (1줄)

```bash
node ~/.claude/skills/searchflow/scripts/env-detect.mjs
```

한 줄짜리 JSON 이 나오면 정상입니다. 예:

```json
{"cross_engine":true,"knowledge_hook":false,"ooo":true,"multi_agent_api":"collab_v2"}
```

파일을 못 찾는다는 오류가 나면 `scripts/` 가 같이 복사되지 않은 것입니다.

**아무것도 없는 환경이면 이렇게 나오고, 그것도 정상입니다** — 저장소 밖 선택 도구가 없다는 뜻일 뿐 공정은 그대로 돕니다:

```json
{"cross_engine":false,"knowledge_hook":false,"ooo":false,"multi_agent_api":"none"}
```

앞의 셋은 참/거짓이고 **`multi_agent_api` 만 문자열**(`public`·`collab_v2`·`none`)입니다 — 없을 때 값이 `false` 가 아니라 `"none"` 입니다.

**종료 코드**: 위처럼 **인자 없이 실행하는 설치 확인은 항상 0** 입니다(없음을 오류가 아니라 값으로 표현합니다). 다만 **`--test`(자체 테스트)만은 실패 시 1** 을 냅니다 — 이쪽은 "부재"가 아니라 "검사기가 깨졌다"는 뜻이라 0으로 덮으면 안 됩니다.

## 사용법

```
/searchflow                       # 인터랙티브 (조사할 것을 물어봅니다)
/searchflow <질문 또는 검증할 주장>   # 바로 착수
```

깊이는 묻지 않습니다 — 점수가 문턱을 넘으면 그 자리에서 끝나고, 못 넘으면 가장 약한 축만 다시 봅니다.

`/deep-research` 로 불러도 동작합니다(구 이름 — SearchFlow 로 위임).

## 문서 언어

사람이 읽는 문서 본문은 **한국어**로 씁니다. `description` 필드만 자리에 따라 갈립니다:

| 자리 | 언어 | 왜 |
|---|---|---|
| **스킬**(`skills/**/SKILL.md`)의 `description` | **영어** | 사람이 아니라 **모델이 스킬을 고를 때 읽는 자리**입니다. 한국어로 적으면 영어로 들어온 요청에서 이 스킬이 안 뽑힙니다 |
| **커맨드**(`commands/*.md`)의 `description` | 한국어 | 슬래시 메뉴에서 **사용자에게 그대로 보이는** 자리입니다 |
| `name` · `argument-hint` | 기존 표기 유지 | 바꾸면 호출 이름이 깨집니다 |

**폐기된 것의 `description` 은 반드시 `[DEPRECATED …]` 로 시작합니다 — 스킬만이 아니라 에이전트·커맨드까지 전부.** 본문에 아무리 큰 경고를 붙여도 무엇을 부를지 고르는 층은 `description` 만 보므로, 본문 배너로는 폐기된 공정이 다시 뽑히는 것을 막지 못합니다. 같은 이유가 에이전트(스폰 대상 선택)와 커맨드(호출 목록)에도 그대로 적용됩니다.

현재 적용 대상 4종: `skills/deep-research-pipeline.md` · `skills/deep-research-source-quality.md` · `agents/deep-researcher.md` · `commands/deep-research.md`.

## 선택 의존성

없어도 완주합니다. 있으면 자동으로 얹어 쓰고, 없으면 **그 사실을 보고서에 라벨로 남깁니다**(조용히 건너뛰지 않습니다).

- **knowledge-manager**: 콘텐츠 추출·저장
- **prompt-engineering-skills**: 워커 프롬프트 최적화

## 공개 전 점검

```bash
node tools/publish-scan.mjs --patterns <저장소 밖 패턴 파일>
```

종료 코드: **0 = 통과 · 1 = 위반 있음 · 2 = 스크립트 자체 오류**. **2 를 통과로 읽지 마세요.** 위반이 나오면 검사 패턴을 좁히는 게 아니라 산출물을 고칩니다.
