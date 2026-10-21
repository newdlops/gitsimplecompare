# 작은 stage 변경 뒤 상태 갱신 — 0.1.72143

기준은 `4fe900e3b62d4e6c70a3fe7ab2a31b63a81e876b`다. 큰 저장소에서 작은 index 변경 뒤 전용 상태 캐시를 다시 만들던 비용을 줄였다. 원래의 모든 Git 작업 속도·Graph 최신화·안정성·자원 목표는 계속 진행 중이다.

## 변경과 안전 경계

5,000개 이상 entry·256개 이상 디렉터리의 source에 Native UNTR가 없고, 같은 저장소 metadata·환경·index 경로의 완료 캐시가 있을 때만 작은 stage 차이를 반영한다. 경로 128개·입력 256KiB를 넘거나 형식·flag·merge stage·split/sparse/submodule 조건이 맞지 않으면 기존 전체 복사/Native 조회로 복구한다. 평평한 저장소와 이미 source에 UNTR가 있는 경우는 기존 단일 조회를 유지한다.

기존 캐시의 의미와 현재 source를 검증한 뒤, 확장이 소유한 index에만 고정된 `update-index -z --index-info` 명령을 보낸다. Git이 추적 경로 변경에 따른 UNTR 무효화를 수행한다. Native 이후 stage 의미가 source와 정확히 같을 때만 현재 source stat을 복원하며, 원래 index 전후 hash·metadata 및 저장소 경계 검사를 그대로 수행한다. 실제 index·refs·작업 파일은 이 경로에서 쓰지 않는다. [Git index-info 문서](https://git-scm.com/docs/git-update-index#_using_index_info)와 [Native 경로 무효화 구현](https://github.com/git/git/blob/master/read-cache.c)을 확인했다.

실행기는 preparation 이후 고정 argv와 등록된 private 경로를 다시 검사한다. 내부 갱신은 조회와 같은 취소·시간 제한·실제 close 정리를 사용하고, 일반 저장소 쓰기 알림을 만들지 않아 자기 상태 조회·Graph·blame를 불필요하게 무효화하지 않는다. 일반 쓰기 명령의 중단 정책과 조회 pipeline의 쓰기 금지는 유지한다.

전체 entry 객체 배열을 보유하지 않고 비교 중인 두 entry와 제한된 변경 입력만 유지한다. staging hash는 64KiB scratch에 작은 조각을 동기로 복사해 crypto 경계 호출을 줄인다. 해시 바이트 순서와 기존 `staging-v1` 식별자는 유지하므로 세션 간 캐시 key를 바꾸지 않는다. 전체 메모리가 상수라는 뜻은 아니다.

## 검증

최종 관련 Node **99개**가 통과했고 실패·취소·skip은 0개다. 타입 검사도 통과했다. Native SHA-1/SHA-256·index v2/v3/v4, add/remove/mode·raw 경로, 지원하지 않는 flag/stage와 큰 변경의 fallback, 완료 warmup 이행, 도중 source staging 변경 및 trustctime=false의 같은 크기/mtime 수정까지 대조했다. 원본 index 바이트·inode·mtime·ctime 보존과 내부 갱신의 mutation 알림 0회, 준비 이후 잘못된 명령/소유 경로 거부 및 실제 자식의 취소·deadline/close도 검사했다. 기존 경로·cache·split/sparse/linked worktree·racy edit·세션 반복과 ordinary write 수명 검사를 포함한다.

별도 Native index **30개**(8,000개 이상 entry, 두 object format과 실제 v2/v3/v4 및 flag/UNTR 상태)에서 이전 parser와 현재 parser의 staging 식별자·형태 정보가 모두 일치한다. source 및 원시 index SHA-256은 JSON 증거에 있다. 해시 writer는 빈/큰 입력·블록 경계·재사용 buffer·잘못된 범위와 finalize를 별도로 대조했다.

초기 비 UTF-8 작업 파일 생성 재현은 sandbox EPERM, 허용 환경의 macOS EILSEQ로 실패했다. 파일 생성 대신 Native raw index 입력으로 수정한 뒤 통과했다. 중간 contract fixture reset과 TypeScript Buffer annotation 오류도 수정했고 실패 로그를 보존했다. 첫 두 성능 초안의 불리한 Node CPU·메모리 결과와 source snapshot도 별도로 보존했다.

## 실제 규모의 상태 갱신

읽기 전용 원본의 30,311개 파일·72,720개 commit·164개 local branch snapshot을 별도 소유 fixture에 재현했다. 합성 작업 branch와 파일은 fixture 안에만 있다. 각 표본은 추적 경로 하나를 새로 추가한 뒤 실제 `PrivateStatusIndex.read`를 호출한다. 이전/수정/수정/이전 순서, source당 10개 표본의 중앙값이다. 준비 완료는 그 read가 실제 예약한 optional warmup만 추가로 기다린 값이다.

| 중앙값 | 이전 | 수정 |
| --- | ---: | ---: |
| 상태 read 시간(ms) | 1371.868 | 703.844 |
| 실제 준비 완료 시간(ms) | 2344.098 | 703.875 |
| 상태 read Node CPU(ms) | 113.994 | 132.558 |
| 실제 준비 완료 Node CPU(ms) | 145.987 | 132.576 |
| 상태 read Git 실행 수 | 6.000 | 2.000 |
| 실제 준비 완료 Git 실행 수 | 7.000 | 2.000 |
| await 직후 heap 증가량(bytes) | 6370216.000 | 2888612.000 |
| await 직후 RSS 증가량(bytes) | 7127040.000 | 704512.000 |

foreground Node CPU는 증가하고 전체 준비 Node CPU는 감소했다. Native Git/browser/OS CPU가 포함된 값은 아니다. heap/RSS는 await 직후 증가량이며 peak·정확한 retained 메모리·전체 자원을 뜻하지 않는다. fixture 생성·변경 준비·표본 전 GC·독립 Native 전체 oracle은 단계 시간/Node CPU 밖이다. 20개 모두 완전한 Native 상태와 일치하고 원본 fixture index도 보존됐다. 다른 시기의 초안 표본과 교차해 인과적 개선율을 만들지 않았다.

## 전체 작업과 실제 PR 버튼

초기, push/tracked push, pull/fetch의 새·알려진 이력·무변경, rebase, merge/no-ff, PR squash·commit별 적용, cherry-pick, loaded/unloaded checkout의 18개 변형을 전후 각각 실행했다. **36개**가 독립 Native HEAD·refs·부모·local-only 및 production HTML/CSP/JS의 최종 DOM 대조를 통과했다. 이 matrix는 1,000개 파일·1,000개 commit·100개 branch·공유 upstream 8개와 monitor 정책을 사용하며, 큰 중첩 저장소의 이행 경로를 직접 측정하는 표본은 아니다.

matrix의 소유 Node/Git/Chromium CPU는 **37434.429→36539.687ms**, RSS 합계 관측 최대는 **699039744→707936256bytes**였다. 별도 한 쌍이며 느려진 작업을 포함한 모든 원시 결과를 보존한다. 전반적인 작업 속도·자원 절감이 모두 입증됐다는 뜻은 아니다.

같은 실제 규모 snapshot의 production PR 버튼과 등록된 extension callback을 B/A/A/B로 실행했다. 비계측 8개와 별도 자원 계측 4개, 총 **12개**가 Native tree·부모·작업트리·최종 refs/HEAD/local-only 표시를 통과했다. GitHub 목록 metadata와 VS Code transport/window/picker만 fixture로 대체한다. 현재 사용자 세션·실제 GitHub 지연을 측정한 것은 아니다.

| PR 최종 frame 중앙값(ms), source/mode당 2개 | 이전 | 수정 |
| --- | ---: | ---: |
| Squash | 6926.000 | 2729.000 |
| Commit별 적용 | 4787.500 | 4160.500 |

별도 PR 자원 표본의 소유 Node/Git/Chromium CPU는 **56752.913→61388.771ms**, RSS 합계 관측 최대는 **690077696→677511168bytes**다. source당 한 번이며 fixture·capture·Native oracle을 포함하고 build/archive·observer/ps 비용은 제외한다. 50ms+ps 간격의 RSS 합계는 공유 페이지 중복과 짧은 peak 누락이 가능하다. 비계측 버튼 시간과 자원 표본 시간을 섞지 않는다.

UI 코드는 변경하지 않았고 새 시각 디자인 감사를 주장하지 않는다. Marketplace 별도 상태 조회, OS 포커스 변경, foreground Host, 강제 reload를 하지 않았다. 실제 Captain·stash·복구 refs·보존 PR worktree는 수정하지 않았다. 기존 lint는 eslint 미설치/미선언으로 실행할 수 없는 상태다. 같은 이름의 JSON에 모든 소스·원시 증거 SHA-256과 불리한 표본을 포함했다.
