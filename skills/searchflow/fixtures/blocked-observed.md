# 차단 실측 기록 — 우회하지 않고 기록한 3건

> 이 파일은 `acquisition.md` §2(하드 게이트)가 **말이 아니라 실제로 작동했다는 증거**다.
> 판정은 `scripts/robots-gate.mjs`, 원장 라인은 `fixtures/ledger-blocked.jsonl`(`grade-ledger` 통과 실측).

## 인용 축 (as-of 고정 — robots.txt 는 예고 없이 바뀐다)

| 필드 | 값 |
|---|---|
| metric | robots.txt 판정(적용 그룹 중 가장 엄한 것) + 원장 기록 성립 |
| observed_at | 2026-07-31 KST |
| environment | `node` 내장 https · UA `SearchFlow/1.0 (research acquisition ladder; respects robots.txt)` |
| content_revision | robots.txt SHA-256 앞 16자 — reddit.com `41aea42110242175`(538B) · nytimes.com `ebe60e191c7f2225`(8,259B) · iana.org `e5c4b84484ee4216`(24B) |

**이 표가 갱신되지 않은 채 판정만 인용되면 오귀속이다.** 재현 시 해시가 다르면 판정도 달라질 수 있다.

## 결과

| # | 대상 | 판정 | 근거 규칙 | 적용 그룹 |
|---|---|---|---|---|
| 1 | `reddit.com` 게시물 경로 | **BLOCKED** | `Disallow: /` | `*` |
| 2 | `nytimes.com/athletic/search/?q=…` | **BLOCKED** | `Disallow: /athletic/search/*` | `*`, `googlebot` |
| 3 | `nytimes.com` 기사 경로 | **BLOCKED** | `Disallow: /` | **`anthropic-ai`** |
| — | `iana.org` 상태코드 등록부 | ALLOWED | 매치 규칙 없음 | `*` |

- **우회 시도 0.** 세 건 모두 대상 URL 을 **취득하지 않았다.** 취득한 것은 `robots.txt` 뿐이며, 그것은 규칙을 알기 위한 정규 경로다.
- 원장 3줄 = `grade=UNREACHABLE` · `status=unreachable` · `grade_basis` 에 무엇이 막았는지 + 적용 그룹까지 명시. `grade-ledger` **exit 0**.
- `#4`(iana) 는 **양성 대조**다 — 게이트가 전부 blocked 를 뱉는 고장이면 세 건의 BLOCKED 는 아무 의미가 없다.

## 이 실측이 코드 결함 2건을 잡았다

프로세스가 규율만으로 돌아갔다면 둘 다 살아남았을 자리다.

### ① 파싱 버그 — 연속 `User-agent:` 줄을 한 그룹으로 안 봤다

대상 사이트가 `User-agent: *` 다음 줄에 `User-agent: Googlebot` 을 두고 그 아래 규칙을 나열했다(RFC 9309 상 **하나의 그룹**). 구판은 두 번째 줄에서 그룹을 무효화해 **실제 `Disallow` 를 `allowed` 로 판정했다**(위 #2). 수리 후 같은 대상 재측정 = `blocked` 로 전이. 회귀 테스트로 박음(`--test`).

### ② 설계 결함 — `*` 만 보면 우리 계열 금지를 통과시킨다

같은 사이트가 `*` 에는 일부만 막고, **`anthropic-ai`·`ClaudeBot`·`Claude-SearchBot`·`Claude-User`·`Claude-Web`·`GPTBot` 등 AI 엔진 계열 이름에는 `Disallow: /`** 를 걸어뒀다. `*` 만 보는 게이트는 위 #3 을 `allowed` 로 낸다 — **발행처가 우리 계열에 대고 하지 말라고 적어둔 것을 무시하는 것**, 이 게이트가 존재하는 이유 그 자체를 위반한다.

처분: 판정을 **적용 가능한 그룹 중 가장 엄한 것**으로 바꿨다(RFC 최소 요구보다 엄함). 대가를 명시한다.

| | 손실 | 성질 |
|---|---|---|
| 과다 차단 | 원장에 `UNREACHABLE` 한 줄 | **보이고, 되돌릴 수 있다** |
| 과소 차단 | 발행처가 금지한 취득의 실행 | 안 보이고, 되돌릴 수 없다 |

비대칭이라 엄한 쪽을 기본값으로 뒀다. RFC 최소 동작은 `--ua-only "*"` 로 내릴 수 있고, `--test` 가 **두 모드의 판정이 실제로 갈린다는 것**까지 확인한다(차이가 없으면 이 설계는 무의미하므로).

⚠️ **미측정**: 이 하네스의 취득 도구가 실제로 어떤 `User-Agent` 문자열을 보내는지 안 쟀다. 그래서 특정 이름을 "우리다"라고 주장하지 않고 계열 후보 전체를 적용 대상으로 잡는다 — 즉 **우리가 그 이름으로 요청한다는 주장이 아니라, 그 이름들에 대한 금지를 우리에게 적용한다는 선택**이다.

## 기계가 판정할 수 없는 층 — 표시만 한다

대상 사이트 `robots.txt` **주석**에 자동 수집·데이터 마이닝·LLM 개발 목적 이용을 금지한다는 문구가 있었다. 주석은 기계 판정 대상이 아니다. 게이트는 `tos_notice` 로 **표시만** 하고 판단은 리드에게 넘긴다 — 여기서 "파싱 못 했으니 없는 것"으로 처리하면 §2 하드 게이트 4종 중 ToS 축이 조용히 사라진다.

`robots.txt` 로 판정 불가한 것: **ToS 문서 · 로그인 · 페이월 · CAPTCHA.** 이 4종은 취득 시도 중 관측해 사람이 원장에 적는다.
