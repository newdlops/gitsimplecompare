# 고정 입력 300행 첫 페이지 검증 — 0.1.72176

이번 작업은 이전 300행 측정의 편차를 분리하는 진단이다. 제품 코드·버전·VSIX는
변경하지 않는다. 전체 부하 성능 목표는 완료되지 않았다.

## 범위와 방법

설치·게시했던 0.1.72173과 0.1.72176 VSIX에서 Graph bundle·Graph CSS·controls CSS를
직접 읽었다. 두 패키지의 전체 media 파일 집합이 같고 변경된 파일은 이 세 개뿐임을
확인했다. 현재 소스의 세 자산은 0.1.72176 패키지와 바이트 단위로 일치했다.

실제 저장소의 Native 첫 페이지와 로컬 branch 상태를 계측 전에 한 번 고정했다.
별도 NUL 형식 Native log와 제품 reader의 전체 필드가 같았으며 입력은 300개 commit,
164개 로컬 branch, 300개 edge, 1개 lane이다. 두 모드의 입력 digest도 같다. 사용자
경로·ref·commit 원문은 보고서에 기록하지 않는다.

같은 Node layout·production HTML·host harness를 사용하고 브라우저의 세 자산만
바꿨다. 각 모드는 B/A/A/B/A/B/B/A 순서의 새 headless Chromium 8개이며 버전당
독립 browser/document 수명은 4개다. CPU는 1배에서, latency는 script 로드 전부터
6배 제한한 별도 실행에서 측정했다. latency 실행은 CPU counter를 끈다. 다른
테스트·빌드·프로파일을 측정 구간과 병행하지 않았다.

CPU 구간은 빈 동일-origin shell 이후 Graph startup부터 ACK와 settle frame까지다.
Git 읽기·Node layout·빌드·모듈 컴파일·Native/DOM 검증·선택 입력·정리는 구간 밖이다.
계측 구간의 종료 Native 자식 CPU는 8개 모두 0이었다. 자연스러운 머신 변동은 남는다.
최초 sandbox 실행은 Chromium Mach bootstrap 권한 오류로 종료됐고, 승인된 headless
실행의 완료 표본만 아래에 사용했다. 중단된 실행을 성공 표본으로 세지 않았다.

## 결과

아래 값은 각 조건의 새 문서 4개 중앙값이다. Node·Chromium 전체·renderer CPU를
구분하고, 소유 CPU는 각 수명에서 합산한 값의 중앙값을 사용한다.

| 지표 | 0.1.72173 | 0.1.72176 |
| --- | ---: | ---: |
| Node CPU, 1배 | 63.14 ms | 70.33 ms |
| Chromium 전체 CPU, 1배 | 194.80 ms | 187.19 ms |
| Chromium renderer CPU, 1배 | 126.41 ms | 134.76 ms |
| 소유 Node + Chromium CPU, 1배 | 276.31 ms | 258.27 ms |
| 렌더 handler + 두 frame, 1배 | 59.0 ms | 48.5 ms |
| mount부터 settle, 1배 | 193.5 ms | 189.0 ms |
| 렌더 handler + 두 frame, 6배 | 772.0 ms | 565.5 ms |
| mount부터 settle, 6배 | 1,408.0 ms | 1,036.5 ms |

Chromium 전체 CPU 중앙값은 3.9% 낮지만 renderer는 6.6%, Node는 11.4% 높다.
인접한 네 쌍의 방향도 섞인다. 따라서 전체 CPU 개선이나 통계적 동등성을 주장하지
않는다. 6배 제한의 중앙 지연은 낮지만 이것 역시 실제 VS Code 입력 지연이나
머신 부하에서의 개선을 입증하지 않는다. 기존 혼합 측정과 불리한 표본은 유지한다.

이 제한된 비교에서는 300행의 큰 CPU 증가가 반복 재현되지 않았다. 제품 소스상
600행 이하에서는 그룹을 만들지 않으며 새 비교의 16개 문서도 그룹 수 0이다.
이 증거로 원인을 특정하지 못한 300행 경로에 추가 변경을 넣지는 않는다.

## 기능·보존·남은 작업

16개 문서 모두 Native와 DOM의 행·ref·HEAD·현재 branch가 같고 실제 선택 동작이
통과했다. 각 모드의 모든 SVG 바이트도 같다. 실제 저장소의 전후 HEAD/index/config/
packed refs/전체 ref 집합이 같았고 읽기 allowlist에서 optional writes·lazy fetch·
fsmonitor를 껐다. 작업트리·index·설정·객체·ref를 수정하지 않았다.

이 headless 측정 자체는 시각 QA나 물리 화면 검증이 아니다. 포커스 변경·강제
VS Code reload·Marketplace 점검도 없다. 후속 실제 버전 활성화와 단일 데스크톱의
읽기 전용 관찰은 [별도 기록](actual-target-runtime-0.1.72176.md)에 남겼다. 실제 창의
전체 작업 경로·동시 부하 CPU 개선은 아직 미검증이며 이 진단으로 목표를 완료하지 않는다.

측정에 사용한 드라이버는 로컬 `/private/tmp/gsc-small-page-matrix.ts`와
`/private/tmp/gsc-small-page-latency.ts`에 보존했다. 각각의 source SHA256은 원시 결과에
기록했다. 실제 저장소 경로가 포함된 드라이버 원문은 공개 기록에 복사하지 않았다.

[1배 CPU 원시 표본](frozen-first-page-cpu-0.1.72176.json),
[6배 latency 원시 표본](frozen-first-page-latency-0.1.72176.json).
