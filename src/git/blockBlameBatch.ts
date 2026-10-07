// 파일 전체 blame을 한 번 정렬하고 블록 범위만 잘라 Code Vision 집계 비용을 줄인다.
// - 작성자·커밋 집계 규칙은 기존 순수 모델을 그대로 재사용한다.
import type { GitBlameLine } from "./blameService";
import { summarizeBlockBlame, type BlockBlameSummary, type SourceBlock } from "./blockBlameModel";

/**
 * 파일 blame을 공유 인덱스로 조회해 여러 소스 블록의 요약을 만든다.
 * - 블록마다 파일 전체를 필터링하는 대신 O(log N) 범위 탐색과 해당 라인만 집계한다.
 * - 중첩·겹치는 블록, 빠진 라인, 섞인 입력 순서를 기존 단일 블록 집계와 동일하게 처리한다.
 * @param blocks 언어 심볼에서 얻은 블록 목록. 반환 순서도 이 목록을 따른다.
 * @param fileBlame 파일 전체의 blame. 정렬할 때 복사하므로 입력 배열은 변경하지 않는다.
 * @returns 기존 모델과 동일한 블록별 작성자·커밋·라인 요약
 */
export function summarizeFileBlame(
  blocks: readonly SourceBlock[],
  fileBlame: readonly GitBlameLine[]
): BlockBlameSummary[] {
  const ordered = [...fileBlame].sort((left, right) => left.line - right.line);
  return blocks.map(block => {
    const startLine = Math.max(1, Math.floor(block.startLine));
    const endLine = Math.max(startLine, Math.floor(block.endLine));
    const start = lowerBound(ordered, startLine);
    const end = lowerBound(ordered, endLine + 1);
    return summarizeBlockBlame(block, ordered.slice(start, end));
  });
}

/**
 * 정렬된 blame에서 지정 라인 이상인 첫 레코드의 배열 위치를 이진 탐색한다.
 * @param lines 1-based 라인 번호로 정렬된 파일 blame
 * @param line 찾을 inclusive 경계. 끝 경계는 endLine + 1을 전달해 exclusive로 사용한다.
 * @returns 경계에 해당하는 첫 위치. 이후 라인이 없으면 배열 길이
 */
function lowerBound(lines: readonly GitBlameLine[], line: number): number {
  let left = 0, right = lines.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (lines[middle].line < line) left = middle + 1;
    else right = middle;
  }
  return left;
}
