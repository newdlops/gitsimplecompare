// Changes 웹뷰 클라이언트가 extension host 로 보내는 메시지 타입.
// - provider 에 inline 으로 두면 메시지 필드 추가 때마다 provider 가 비대해져 별도 protocol 로 분리한다.

/**
 * media/changes/changes.js 가 postMessage 로 보내는 명령 요청.
 * - type 에 따라 일부 필드만 사용한다.
 */
export interface ChangesWebviewMessage {
  type: string;
  side?: "from" | "to";
  path?: string;
  root?: string;
  section?: string;
  paths?: string[];
  message?: string;
  prompt?: string;
  op?: string;
  autoGenerate?: boolean;
  action?: string;
  ref?: string;
  stashKey?: string;
  stage?: string;
  status?: string;
  repoRoot?: string;
  branch?: string;
  isMain?: boolean;
  oldPath?: string;
  baseRef?: string;
  headRef?: string;
  shortHash?: string;
  title?: string;
  hookName?: string;
  enabled?: boolean;
  line?: number;
  column?: number;
}
