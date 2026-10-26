# 0.1.72177 — 무효 status의 미추적 파일 열거 생략

공유 private status가 이미 metadata 변경으로 무효가 됐으면 후속 ls-files를 실행하지
않는다. 전체 status 재조회와 마지막 index·연결 검증은 유지한다. 또한 HEAD와 설정을
제자리에서 바꿨다 원복한 경우도 검출해 일시적인 다른 checkout/작업트리 상태를
Graph·Changes·Explorer에 게시하지 않는다.

## 근거와 검증

0.1.72176의 실제 창에서 포커스 복귀와 badge 갱신 사이 약 15초 동안 private status,
미추적 파일 열거, fsmonitor 응답 실패와 index/metadata 무효화가 기록됐다.
마지막 decoration 로그의 22 ms는 전체 대기 시간이 아니다. 기존 로그만으로는
실제 index 변경과 metadata 변경을 분리할 수 없어 15초 전체 원인을 특정하지 않았다.
이번 버전은 이른 무효화 phase와 마지막 검증의 index/metadata 구분을 Output에 남긴다.

일반 저장소와 linked worktree의 전용·공용 metadata에 임시 파일을 만들고 제거하는
소유 Native fixture에서 결과가 버려져도 미추적 파일 열거를 먼저 실행하는 비용을
재현했다. 최종 시나리오에서 status는 여전히 2회, 열거는 2회에서 1회가 된다.
저장소 디렉터리·gitfile·commondir 교체/원복 검사는 유지했다. HEAD·config 재쓰기와
없던 config.worktree의 생성/제거도 실제 외부 HEAD/파일 상태를 주입해 검증했다.

고정 baseline 69e8fd3의 세 Git 모듈만 대체한 최종 회귀 7개는 5개 실패·2개 통과였다.
최종 관련 Node 114개, 타입 검사, production 빌드가 통과했다. 새 package의 runtime
81개는 소스 산출물과 같고 0.1.72176 대비 dist/extension.js만 바뀌었다. 브라우저 자산,
테마, badge 문구와 공개 API는 그대로다. 이번 버전의 별도 시각 QA는 수행하지 않았다.

## 소유 fixture의 자원 비교

tracked 2,000개, untracked 1,000개/16개 디렉터리의 임시 저장소 3개를 사용했다.
한 Node harness에서 조건별 4회씩 순서를 바꾼 48개 표본이다. 같은 저장소 안의
4회는 상관된 반복이며 먼저 저장소별 중앙값을 계산한다. 빌드·구성·독립 Native
oracle·원본 index 검증·정리를 제외하고 종료된 Native 자식과 Node CPU를 분리했다.
이 구간에 다른 테스트·빌드·프로파일은 병행하지 않았다.

| metadata 무효화 사례 | 기존 Native CPU | 변경 Native CPU | 전체 Git 호출 |
| --- | ---: | ---: | ---: |
| fixture 1 중앙값 | 365.84 ms | 349.43 ms | 5 → 4 |
| fixture 2 중앙값 | 245.89 ms | 243.11 ms | 5 → 4 |
| fixture 3 중앙값 | 137.74 ms | 115.44 ms | 5 → 4 |

이 사례의 소유 Node+Native CPU 중앙값은 fixture별 4.2%, 1.5%, 14.9% 줄었다.
경과 시간 방향은 섞이므로 반복 가능한 latency 개선으로 주장하지 않는다.

정상 조회는 Git 호출이 그대로 3회였다. 소유 CPU 변화도 +7.1%, −3.7%, +0.5%로
섞였고 Node의 파일 검증 비용이 추가됐다. 이 불리한 표본도 모두 보존했다.
전체 앱 CPU 감소·정상 조회 동등성·실제 VS Code 응답 개선은 아직 입증하지 않았다.
모든 Native 결과와 실제 원본 index의 바이트·inode·mtime·ctime은 일치했다.

사용자 저장소의 index·ref·config·stash·복구 worktree를 변경하지 않았다. 실제 창의
native 입력·포커스 변경·강제 reload와 Marketplace 점검도 수행하지 않았다.

[원시 48개 표본](benchmarks/status-expansion-0.1.72177.json),
[회귀·타입·빌드 검증](benchmarks/status-expansion-verification-0.1.72177.json),
[패키지 바이트 검증](benchmarks/release-artifact-0.1.72177.json).

로컬 실험 드라이버는 /private/tmp/gsc-status-binding-benchmark-72177.mjs와
/private/tmp/gsc-status-binding-baseline-72177.mjs에 보존했다. 측정한 source/driver
SHA256과 검사 로그 digest는 결과 파일에 기록했다. 실제 창의 15초 대기와 전체
동시 부하 응답은 후속 검증 대상이며, 전체 성능 목표는 active다.
