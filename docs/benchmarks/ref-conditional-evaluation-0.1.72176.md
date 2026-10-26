# Native ref 조건부 출력 평가 — 0.1.72176

조건부 short-name 후보는 배포에서 제외한다. 제품은 기존 Native ref 이름 계산을
유지한다. 이번 작업은 진단이며 extension runtime·UI·버전을 변경하지 않는다.

## 비용과 의미

현재 fingerprint는 전체 ref의 이름·OID·Native short name을 한 번에 읽고,
원격 ref의 short name을 후속 catalog에 재사용한다. 비원격 ref의 세 번째 필드는
fingerprint에 사용하지 않으므로, 조건문으로 원격 ref에만 short name을 출력하는
후보를 소유 임시 저장소에서 비교했다.

설치된 Git은 2.53.0이다. 해당 버전의
[populate_value와 get_ref_atom_value](https://github.com/git/git/blob/v2.53.0/ref-filter.c#L2310-L2531)는
처음 필드를 요청할 때 사용한 refname atom들을 함께 채운다.
[조건문 handler](https://github.com/git/git/blob/v2.53.0/ref-filter.c#L1138-L1167)는
이미 생성한 출력 중 하나를 선택한다. 이 구조에서는 조건문으로 감싸도
비원격 ref의 short-name 계산을 없애지 못한다.

## 측정

첫 비교는 별도 임시 저장소 3개에서 72개 wall-time 표본을 수집했다.
조건부 형식의 중앙값이 낮았지만 표본 변동이 컸으며 Git CPU를 측정하지 않았다.
이를 CPU 개선 근거로 채택하지 않았다.

후속 비교는 별도 임시 저장소 3개, 저장소당 6개 순서 조합에서 54개 표본을
수집했다. 각 저장소는 packed ref 2,123개(태그 2,000·원격 100·로컬 22·기타 1)를
가지며, 원격 이름과 충돌하는 로컬 이름도 포함한다. Node 자기 CPU와 OS가 회수한
종료 Git 자식 CPU를 구분했다. 모듈 빌드·fixture 구성·검증·정리는 측정 밖이다.
측정 중 다른 테스트·빌드·프로파일을 실행하지 않았다.

| 임시 저장소 | 기존 Git CPU 중앙값 | 조건부 Git CPU 중앙값 | 변화 | wall-time 변화 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 152.2315 ms | 156.0910 ms | +2.54% | −7.26% |
| 2 | 79.5065 ms | 84.2860 ms | +6.01% | −19.16% |
| 3 | 70.3350 ms | 73.5475 ms | +4.57% | +21.57% |

원시 ref만 출력한 대조군은 계산 비용이 낮았지만 Native 원격 short name을 제공하지
않으므로 제품을 대체할 수 없다. 모든 형식의 ref·OID와 후보의 원격 이름 일치,
실험 전후 ref 보존을 확인했다. 이 수치는 소유 fixture의 단일 조회 진단이며,
통계적 유의성·전체 앱 CPU·실제 VS Code 응답 개선을 입증하지 않는다.

## 실제 구성과 남은 검증

열린 실제 window1의 Graph 로그가 가리키는 저장소에서 공통 Git 실행기의 읽기
allowlist로 두 번 조회했다. ref는 총 2,782개(로컬 164·원격 2,113·태그 388·stash 1·
복구 116)였으며 두 결과와 HEAD/index/config metadata는 같았다. lazy fetch·optional
locks·fsmonitor를 끄고 경로·ref 이름·OID는 결과에 내보내지 않았다. 작업트리·설정·
index·객체·ref는 수정하지 않았다. 실제 구성은 태그가 대부분인 합성 fixture와 다르다.

첫 페이지와 브랜치 상세는 현재 `GraphFirstPageRead.during`에서 이미 병렬로
준비한다. 이 검토를 근거로 두 단계를 직렬 병목으로 단정하거나 같은 변경을
다시 제안하지 않는다. fingerprint는 direct reload보다 먼저 확정하는 구조이며,
이를 바꾸려면 snapshot 의미·취소·stale 게시 방지까지 별도로 검증해야 한다.

0.1.72176은 이미 커밋·푸시·게시·설치됐으며 이 진단으로 새 VSIX를 만들지 않았다.
01:32:43 UTC 관찰에서 실제 창 4개는 여전히 0.1.72175였다. 최신 실제 창의 응답,
작은 첫 페이지 동등성 및 전체 CPU 개선은 미검증이며 목표는 완료되지 않았다.
창 포커스 변경·강제 reload·Marketplace 점검은 수행하지 않았다.

재현: `node scripts/benchmark-ref-conditional.mjs /private/tmp/ref-conditional.json`.
Node 설치본의 헤더와 POSIX C compiler가 필요하다. 사용자 저장소를 사용하지 않는다.

[최초 wall 표본](ref-conditional-wall-0.1.72176.json),
[후속 CPU·wall 표본](ref-conditional-cpu-0.1.72176.json),
[실제 읽기 전용 개수·보존 결과](ref-conditional-actual-counts-0.1.72176.json).
