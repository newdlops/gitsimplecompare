// 비모달 알림의 응답 수명을 Git 작업과 분리하고 폐기된 패널의 콜백·진단을 해제한다.

/** 원래 작업의 완료와 저장소 수명에 연결된 알림/후속 실행 경계다. */
export interface ActionNoticeScope {
  readonly signal: AbortSignal;
  present<T>(show: () => Thenable<T>, selected: (value: T) => void | Promise<void>): void;
  background(read: (signal: AbortSignal) => Promise<void>): void;
  run(action: (refresh: () => Promise<void>) => Promise<void>): Promise<void>;
}

interface Ticket<T = unknown> {
  selected?: (value: T) => void | Promise<void>;
  failed?: (error: unknown) => void;
  release?: () => void;
}

/** 응답 Promise는 지워진 ticket만 보유하게 해 닫히지 않은 네이티브 알림이 패널을 붙잡지 않게 한다. */
async function settle<T>(ticket: Ticket<T>, value?: T, error?: unknown): Promise<void> {
  const selected = ticket.selected, failed = ticket.failed;
  ticket.release?.(); clearTicket(ticket);
  try { if (error !== undefined) failed?.(error); else await selected?.(value as T); }
  catch (failure) { failed?.(failure); }
}

/** 콜백이 참조하는 서비스·패널을 즉시 해제한다. 원래 알림 Promise는 취소할 필요가 없다. */
function clearTicket(ticket: Ticket<any>): void {
  ticket.selected = undefined; ticket.failed = undefined; ticket.release = undefined;
}

/** 패널 하나의 보류 알림은 최대 16개, 자동 선행 진단은 최신 한 개만 유지한다. */
export class DeferredActionNotices {
  private controller = new AbortController();
  private readonly tickets = new Set<Ticket<any>>();
  private backgroundRead?: AbortController;

  /** @param failed 후속 알림/Undo 오류를 OUTPUT과 기존 오류 UI에 기록한다. */
  constructor(private readonly failed: (error: unknown) => void) {}

  /** 저장소 전환/패널 폐기 때 알림의 후속 작업과 자동 진단을 함께 해제한다. */
  cancel(): void {
    this.controller.abort(); this.controller = new AbortController();
    this.backgroundRead?.abort(); this.backgroundRead = undefined;
    for (const ticket of this.tickets) clearTicket(ticket);
    this.tickets.clear();
  }

  /**
   * 원래 Git 작업이 busy를 해제한 후에만 늦은 Undo/진단을 실행하는 범위를 만든다.
   * @param ready 원래 작업 finally가 완료한 신호 @param current 원래 저장소/패널 세대가 유효한지 검사
   * @param run 충돌하는 Git 작업 확인과 새 busy/refresh 수명을 제공하는 패널 adapter
   */
  scope(ready: Promise<void>, current: () => boolean,
    run: ActionNoticeScope["run"]): ActionNoticeScope {
    const signal = this.controller.signal;
    const active = () => !signal.aborted && current();
    return {
      signal,
      present: <T>(show: () => Thenable<T>, selected: (value: T) => void | Promise<void>) => {
        if (!active()) return;
        while (this.tickets.size >= 16) {
          const oldest = this.tickets.values().next().value!;
          this.tickets.delete(oldest); clearTicket(oldest);
        }
        const ticket: Ticket<T> = { selected: value => active() ? selected(value) : undefined,
          failed: this.failed, release: () => this.tickets.delete(ticket) };
        this.tickets.add(ticket);
        try { void Promise.resolve(show()).then(value => settle(ticket, value), error => settle(ticket, undefined, error)); }
        catch (error) { void settle(ticket, undefined, error); }
      },
      background: read => {
        if (!active()) return;
        this.backgroundRead?.abort();
        const controller = new AbortController(); this.backgroundRead = controller;
        const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
        void ready.then(async () => {
          if (active() && !controller.signal.aborted) await read(controller.signal);
        }).catch(error => { if (!controller.signal.aborted) this.failed(error); }).finally(() => {
          signal.removeEventListener("abort", abort);
          if (this.backgroundRead === controller) this.backgroundRead = undefined;
        });
      },
      run: async action => { await ready; if (active()) await run(action); },
    };
  }
}

/** 패널에서는 응답을 보류 등록하고, 수명 범위가 없는 기존 명령 호출은 이전 await 계약을 유지한다. */
export async function presentActionNotice<T>(scope: ActionNoticeScope | undefined, show: () => Thenable<T>,
  selected: (value: T) => void | Promise<void> = () => {}): Promise<void> {
  if (scope) scope.present(show, selected);
  else await selected(await show());
}
