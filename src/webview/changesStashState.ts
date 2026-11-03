import type { StashView } from "../commands/stash";

/** 목록 전체 조회와 표시용 추가 조회를 구분하는 stash 섹션 상태다. */
export interface StashPagination { hasMore: boolean; loading: boolean; error?: string }

/** provider 본체에서 stash 목록·페이지 상태의 책임을 분리하고 기존 렌더 경로를 재사용한다. */
export class ChangesStashState {
  items: StashView[] = [];
  pagination: StashPagination = { hasMore: false, loading: false };
  /** @param render 항목 또는 로딩 상태가 변경된 뒤 호출할 provider 렌더 함수 */
  constructor(private readonly render: () => void) {}
  /** undefined 항목은 현재 목록을 유지하고 페이지 상태만 갱신한다. 일반 목록 교체는 페이지 상태도 초기화한다. */
  set = (items?: StashView[], pagination?: StashPagination): void => {
    if (items !== undefined) this.items = items;
    this.pagination = pagination ?? { hasMore: false, loading: false }; this.render();
  };
  /** 저장소 전환 시 렌더 이전에 이전 목록과 로딩·오류를 함께 비운다. */
  reset(): void { this.items = []; this.pagination = { hasMore: false, loading: false }; }
}
