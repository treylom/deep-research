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

## MCP 서버 (선택 — 공정을 하네스 밖에서 강제)

`skills/searchflow/scripts/mcp-server.mjs` 는 조사→제출→판정을 **서버가 쥐는** stdio MCP 서버입니다. 없어도 스킬 단독으로 완주하고(2층 계약), 있으면 채점 기준이 조사 워커의 컨텍스트에 **아예 안 실립니다**.

**Claude Code** — 플러그인으로 설치하면 동봉된 `.mcp.json` 이 자동으로 잡습니다. 수동 등록은:

```json
{ "mcpServers": { "searchflow": {
  "command": "node",
  "args": ["<이 저장소 경로>/skills/searchflow/scripts/mcp-server.mjs"] } } }
```

비대화형(`claude -p`)으로 돌릴 때는 **도구가 보이는 것과 호출이 허용되는 것이 다릅니다.** 등록만 하면 도구 목록에는 뜨지만 호출은 `…but you haven't granted it yet` 으로 막힙니다. 쓸 도구를 명시해 주세요 — 이름 앞에 서버 이름이 붙습니다:

```bash
claude -p --mcp-config <위 json 경로> --strict-mcp-config \
  --allowedTools "mcp__searchflow__searchflow_start" \
  "<프롬프트>"
```

⚠️ **플러그인으로 설치했을 때는 도구 이름이 달라집니다.** 위 수동 등록의 이름이 아니라, 서버 이름 앞에 플러그인 이름이 한 겹 더 붙습니다. 실제 이름은 이렇게 확인하세요:

```bash
claude mcp list      # → plugin:searchflow:searchflow  ✔ Connected
```

여기 보이는 `plugin:A:B` 가 `mcp__plugin_A_B__<도구>` 가 됩니다. 이름 안의 하이픈은 그대로 남습니다(예: `plugin:memory-bank:memory-bank` → `mcp__plugin_memory-bank_memory-bank__…`).

**마켓플레이스 항목 이름은 여기 안 들어갑니다** — 들어가는 것은 플러그인 자신의 이름(`.claude-plugin/plugin.json` 의 `name`)입니다. 이 저장소가 그 예입니다: 항목 이름은 `deep-research` 인데 도구 이름은 `searchflow` 쪽을 씁니다.

그리고 — **개발 중 `--plugin-dir` 로 붙이면 이 MCP 서버는 안 잡힙니다.** 그 경로에서는 `.mcp.json` 이 읽히지 않습니다(파일 위치를 네 가지로 바꿔 확인 — 어디에 두든 도구가 안 뜹니다). 개발 중에는 위 수동 등록(`--mcp-config`)을 쓰세요.

**Codex CLI** — `~/.codex/config.toml` 에 **절대 경로**로 적습니다(플러그인 루트 변수는 없습니다):

```toml
[mcp_servers.searchflow]
command = "node"
args = ["/절대/경로/skills/searchflow/scripts/mcp-server.mjs"]
```

이 표기는 `codex mcp add` 가 실제로 만들어내는 것과 같습니다(실측 확인).

**대화형(TUI)** 은 첫 호출에서 승인 창이 뜹니다 — `Allow` 를 한 번 누르면 왕복합니다.

**비대화형(`codex exec`)** 은 **기본 설정에서는** 승인 창을 띄울 자리가 없어 호출이 그대로 취소됩니다. 전역 승인 정책(`-a never`)만으로는 **안 풀립니다** — 그 설정은 MCP 도구 승인까지 덮지 않습니다. 도구별 승인 키를 같이 주세요:

```bash
codex -a never exec --json \
  -c 'mcp_servers.searchflow.tools.searchflow_start.approval_mode="approve"' \
  "<프롬프트>"
```

- `-a never` 는 **서브커맨드 앞**입니다 (`codex exec -a never` ❌).
- 키 이름에 도구 이름이 들어갑니다 — 쓰는 도구마다 한 줄씩 필요합니다. **실제로 돌려본 것은 `searchflow_start` 하나**이고, 나머지 둘은 같은 형태일 것이라는 추정입니다.
- 서버 단위로 한 번에 거는 `mcp_servers.searchflow.default_tools_approval_mode` 도 공식 문서에 있습니다. 다만 **우리가 실호출로 확인한 것은 도구별 키 쪽뿐**입니다.
- 이 키가 끄는 것은 "이 도구를 호출해도 됩니까"라는 물음입니다. 무인 실행 환경에서만, 무엇을 끄는지 알고 쓰세요.

**동작 확인** — 서버는 줄 단위 JSON-RPC 를 씁니다:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node skills/searchflow/scripts/mcp-server.mjs
```

도구 3종(`searchflow_start`·`searchflow_submit`·`searchflow_gate`)이 나오면 정상입니다. 자체 테스트는 `--test`(실패 시 종료 코드 1).

**세션 원장**은 저장소 밖에 씁니다 — 기본 `~/.searchflow/sessions/`, `SEARCHFLOW_STATE_DIR` 로 바꿀 수 있습니다.

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

커밋 메시지도 같은 규칙으로 봅니다 — `--git-log <범위>`. 파일은 다음 커밋에 고치면 되지만 **올라간 메시지는 그렇게 못 고칩니다**.

### push 를 막는 자리에 두기

결과를 보고 사람이 멈추는 방식은 재발합니다. 훅으로 옮기세요:

```bash
cp tools/hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

작업 트리와 **이번에 올라가는 커밋 범위**를 둘 다 검사하고, 위반이면 push 를 막습니다. 패턴 파일을 못 찾아도 막습니다(확인 불가 = 통과 아님). 우회는 `git push --no-verify` — 조용히 지나가는 것과 명시적으로 끄는 것은 다릅니다.
