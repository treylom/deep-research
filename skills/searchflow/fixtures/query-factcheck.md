# 고정 질의 — factcheck 완주용 (AC8 / AC9)

> 이 파일은 **파이프라인 완주 판정용 고정 입력**이다. 내용 품질 판정은 도메인 테스트 소관이며,
> 여기서 보는 것은 "무에러 완주 + artifact 실재"뿐이다.
>
> 고정 fixture 인 이유: 질의가 실행마다 바뀌면 두 실행의 차이가 코드 변경 때문인지
> 질의 때문인지 갈리지 않는다.

## 질의

RFC 9110(HTTP Semantics)은 HTTP 상태코드 418("I'm a teapot")을 정식 상태코드로 등재하고 있는가?

## 이 질의를 고른 이유

- **유형이 명확하다** — 검증 가능한 단일 주장 = `factcheck` 판정이 흔들리지 않는다.
- **원Source 가 공개·무료·안정 URL 에 있다** — IETF RFC 문서. 페이월·로그인·robots 차단이 없어 취득 사다리 ①~②단에서 끝난다(브라우저 도구 없는 순정 환경에서도 완주 가능).
- **지지/반증 양쪽에 실제 자료가 있다** — 418 은 RFC 2324(만우절 RFC)에서 나왔고 이후 문서에서 다뤄진 이력이 있어, `factcheck` 프레임 ②지지·③반증 축이 둘 다 빈손으로 끝나지 않는다.
- **시점 라벨 함정이 내장돼 있다** — "등재/정식" 이라는 라벨이 문서마다 다른 의미로 쓰여, `report-contract.md` 의 시점·라벨 게이트 칸이 실제로 채워져야 한다.

## 완주 판정 (AC8)

```bash
test -s out/report.md && test -s out/sources.jsonl
node skills/searchflow/scripts/grade-ledger.mjs out/sources.jsonl   # exit 0
```

## 강등 판정 (AC9)

enhanced 의존이 전부 부재한 환경(교차 CLI 없음 · 지식 훅 없음 · ooo 없음 · v2 namespace 없음)에서:

- 에러 0 으로 core 완주
- `out/report.md` 「환경·한계」 칸에 격하 라벨 문자열이 **실재** (`grep` 1건 이상 — 교차 엔진 미수행 · parallelism)
