// VS Code workspaceState를 pending review local draft storage로 연결하는 adapter.
// - GitHub draft service는 vscode에 의존하지 않고, 이 파일만 persistence API 세부를 안다.
import type * as vscode from "vscode";
import type {
  LocalPullRequestReviewDraft,
  PullRequestReviewDraftStorage,
} from "../git/pullRequestReviewDraftService";

/** workspace별 review draft를 직렬로 저장하는 vscode.Memento adapter. */
export class WorkspaceReviewDraftStorage implements PullRequestReviewDraftStorage {
  private writeChain: Promise<void> = Promise.resolve();

  /** @param state 현재 workspace에 귀속되는 VS Code memento */
  public constructor(private readonly state: vscode.Memento) {}

  /** raw unknown value를 서비스가 안전하게 decode하도록 그대로 반환한다. */
  public async read(key: string): Promise<unknown> {
    await this.writeChain;
    return this.state.get<unknown>(key);
  }

  /** 동시에 debounce된 draft가 역순으로 저장되지 않도록 update를 한 줄로 직렬화한다. */
  public write(key: string, value: LocalPullRequestReviewDraft): Promise<void> {
    return this.enqueue(() => this.state.update(key, value));
  }

  /** 성공한 discard 뒤에만 workspace record를 제거한다. */
  public remove(key: string): Promise<void> {
    return this.enqueue(() => this.state.update(key, undefined));
  }

  /** memento update 실패도 다음 입력 저장을 막지 않도록 chain의 실패를 복구한다. */
  private enqueue(update: () => Thenable<void>): Promise<void> {
    const next = this.writeChain.then(update);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
