// PR의 기존 호출 경계를 유지하며 실제 index 보호는 브랜치 작업과 같은 Git 모듈에 위임한다.
export { resetOperationResult as resetPullRequestResult } from "./operationResultReset";
