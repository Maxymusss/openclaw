import { resolveChatAgentId } from "./chat-agent-id.ts";
import {
  getChatPendingInputs,
  getChatRecoveryInputs,
  showLatestChatPendingInputs,
} from "./chat-pending-inputs.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { closeSlot, isSidebarSlotVisible, type SidebarLayout } from "./sidebar-layout.ts";

type RecoveryHost = ChatState & { sidebarLayout: SidebarLayout };

type RecoveryScope = {
  host: RecoveryHost;
  sessionKey: string;
  sessionId: string | null;
  agentId: string;
  seen: Set<string>;
  ready: boolean;
  preparing: boolean;
  failed: boolean;
};

/** Pane-local presentation only; the pending-input owner retains data and reconciliation. */
export class ChatInputRecoveryPresentation {
  private scope?: RecoveryScope;

  private current(host: RecoveryHost): RecoveryScope | undefined {
    const scope = this.scope;
    return scope?.host === host &&
      scope.sessionKey === host.sessionKey &&
      scope.sessionId === (host.currentSessionId ?? null) &&
      scope.agentId === resolveChatAgentId(host)
      ? scope
      : undefined;
  }

  retire(): void {
    this.scope = undefined;
  }

  isReady(host: RecoveryHost): boolean {
    return this.current(host)?.ready === true;
  }

  layout(host: RecoveryHost, layout: SidebarLayout): SidebarLayout {
    // Restored tabs must not open an empty shell while this conversation is checked.
    return !this.isReady(host) &&
      layout.columns.some((column) => column.panels.some((panel) => panel.slot === "recovery"))
      ? closeSlot(layout, "recovery")
      : layout;
  }

  sync(
    host: RecoveryHost,
    options: {
      isPresented: () => boolean;
      prepare: () => Promise<void>;
      open: () => void;
      onError: (error: unknown) => void;
    },
  ): void {
    let scope = this.current(host);
    if (!scope) {
      scope = {
        host,
        sessionKey: host.sessionKey,
        sessionId: host.currentSessionId ?? null,
        agentId: resolveChatAgentId(host),
        seen: new Set(),
        ready: false,
        preparing: false,
        failed: false,
      };
      this.scope = scope;
    }
    const view = getChatPendingInputs(host);
    if (
      !options.isPresented() ||
      !host.connected ||
      !view ||
      view.client !== host.client ||
      view.connectionEpoch !== host.connectionEpoch ||
      scope.preparing ||
      scope.failed
    ) {
      return;
    }
    const inputs = getChatRecoveryInputs(host, { latest: true });
    const unseen = inputs.filter((input) => !scope.seen.has(input.id));
    if (scope.ready) {
      if (unseen.length) {
        unseen.forEach((input) => scope.seen.add(input.id));
        if (!isSidebarSlotVisible(host.sidebarLayout, "recovery")) {
          showLatestChatPendingInputs(host);
          options.open();
        }
      }
      return;
    }
    if (!inputs.length && view.latestPage.nextBefore === undefined) {
      return;
    }
    scope.preparing = true;
    const pendingScope = scope;
    const layout = host.sidebarLayout;
    const client = host.client;
    const epoch = host.connectionEpoch;
    // Module acquisition is invisible. Data and panel chrome become visible together.
    void options
      .prepare()
      .then(
        () => {
          if (
            this.current(host) !== pendingScope ||
            host.client !== client ||
            host.connectionEpoch !== epoch ||
            !host.connected
          ) {
            return;
          }
          const remaining = getChatRecoveryInputs(host, { latest: true });
          pendingScope.ready =
            remaining.length > 0 || getChatPendingInputs(host)?.latestPage.nextBefore !== undefined;
          if (options.isPresented()) {
            remaining.forEach((input) => pendingScope.seen.add(input.id));
          }
          // A newer layout choice wins over automatic presentation, including closing a tab.
          if (host.sidebarLayout === layout && remaining.length && options.isPresented()) {
            showLatestChatPendingInputs(host);
            options.open();
          }
          host.requestUpdate?.();
        },
        (error: unknown) => {
          if (
            this.current(host) !== pendingScope ||
            host.client !== client ||
            host.connectionEpoch !== epoch
          ) {
            return;
          }
          pendingScope.failed = true;
          options.onError(error);
        },
      )
      .finally(() => {
        pendingScope.preparing = false;
        // Fresh custody can arrive while the old connection is still preparing its panel.
        if (this.current(host) === pendingScope) {
          host.requestUpdate?.();
        }
      });
  }
}
