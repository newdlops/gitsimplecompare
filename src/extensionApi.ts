// 확장이 다른 확장에 노출하는 공개 API 계약.
// - activation 조립 코드와 소비자 타입을 분리해 공개 표면이 생명주기 구현에 의존하지 않게 한다.
import type * as vscode from "vscode";
import type { ComparisonSnapshot } from "./git/comparisonService";

/** 다른 확장이 활성 Explorer 비교 결과를 선택적으로 재사용하는 공개 API. */
export interface GitSimpleCompareApi {
  /** 공개 계약 버전. 하위 호환이 깨지는 변경을 소비자가 구분하는 데 사용한다. */
  version: 1;
  /** 비교 선택·새로고침·토글 상태가 바뀔 때 발생하는 이벤트. */
  onDidChangeComparison: vscode.Event<void>;
  /** 현재 표시 중인 직렬화 가능한 비교 스냅샷을 반환한다. */
  getComparison(): ComparisonSnapshot | undefined;
}
