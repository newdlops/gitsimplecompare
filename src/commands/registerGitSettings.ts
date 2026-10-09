// 내장 Git 제어와 자체 Git 실행 파일 설정 명령 등록을 모은 배선 모듈.
import * as vscode from "vscode";
import { configureGitExecutable } from "./gitExecutable";
import { toggleBuiltinGit, type BuiltinGitScope } from "./viewState";
import type { CommandDeps } from "./shared";
import { registerRepositorySetupCommands } from "./repositorySetup";

const BUILTIN_GIT_COMMANDS: Array<[string, BuiltinGitScope]> = [
  ["gitSimpleCompare.toggleBuiltinGit", "workspace"],
  ["gitSimpleCompare.toggleBuiltinGit.checked", "workspace"],
  ["gitSimpleCompare.toggleBuiltinGit.unchecked", "workspace"],
  ["gitSimpleCompare.toggleBuiltinGitUser", "user"],
  ["gitSimpleCompare.toggleBuiltinGitUser.checked", "user"],
  ["gitSimpleCompare.toggleBuiltinGitUser.unchecked", "user"],
];

/**
 * Git 설정 명령과 실제 핸들러를 연결해 중앙 명령 목록의 크기를 제한한다.
 * @param deps 실행 경로 진단에서 사용할 활성 저장소 의존성
 * @returns 확장 컨텍스트에 등록할 명령 구독 목록
 */
export function registerGitSettingsCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    ...registerRepositorySetupCommands(deps),
    ...BUILTIN_GIT_COMMANDS.map(([command, scope]) =>
      vscode.commands.registerCommand(command, () => toggleBuiltinGit(scope))),
    vscode.commands.registerCommand("gitSimpleCompare.configureGitExecutable", () => configureGitExecutable(deps)),
  ];
}
