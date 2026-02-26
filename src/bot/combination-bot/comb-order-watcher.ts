import ExchangeService from "@/services/exchange-service/exchange-service";
import { IWSOrderUpdate } from "@/services/exchange-service/exchange-type";

type PendingRequest = {
  resolve: (update: IWSOrderUpdate) => void;
  reject: (error: Error) => void;
  timeoutHandle?: NodeJS.Timeout;
  earlyResult?: { type: "success"; value: IWSOrderUpdate } | { type: "error"; value: Error };
};

const FAILURE_STATUSES = new Set(["canceled", "partially_filled_canceled", "unknown"]);

export type CombOrderWatcherResult = IWSOrderUpdate;

export type CombPreRegisteredOrder = {
  wait: (timeoutMs?: number) => Promise<CombOrderWatcherResult>;
  cancel: () => void;
};

class CombOrderWatcher {
  private pendingRequests = new Map<string, PendingRequest>();
  private subscribers = new Set<(update: IWSOrderUpdate) => void>();
  private removeOrderListener?: () => void;
  private defaultTimeoutMs: number;

  constructor() {
    this.defaultTimeoutMs = Math.max(1000, 10_000);
    this.removeOrderListener = ExchangeService.hookOrderListener((update) => this._handleOrderUpdate(update));
  }

  preRegister(clientOrderId: string): CombPreRegisteredOrder {
    if (!clientOrderId) {
      return {
        wait: () => Promise.reject(new Error("[COMB] Invalid clientOrderId supplied")),
        cancel: () => { },
      };
    }
    if (this.pendingRequests.has(clientOrderId)) {
      return {
        wait: () =>
          Promise.reject(new Error(`[COMB] Already awaiting clientOrderId ${clientOrderId}`)),
        cancel: () => { },
      };
    }
    let resolvePromise: (update: IWSOrderUpdate) => void;
    let rejectPromise: (error: Error) => void;
    const promise = new Promise<CombOrderWatcherResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingRequest = { resolve: resolvePromise!, reject: rejectPromise! };
    this.pendingRequests.set(clientOrderId, pending);

    const wait = (timeoutMs?: number): Promise<CombOrderWatcherResult> => {
      if (pending.earlyResult) {
        this.pendingRequests.delete(clientOrderId);
        if (pending.earlyResult.type === "success") return Promise.resolve(pending.earlyResult.value);
        return Promise.reject(pending.earlyResult.value);
      }
      const waitTimeout = timeoutMs ?? this.defaultTimeoutMs;
      pending.timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(clientOrderId);
        rejectPromise(new Error(`[COMB] Timed out waiting for fill (clientOrderId=${clientOrderId})`));
      }, waitTimeout);
      return promise;
    };
    const cancel = () => {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      this.pendingRequests.delete(clientOrderId);
    };
    return { wait, cancel };
  }

  onOrderUpdate(listener: (update: IWSOrderUpdate) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  dispose() {
    this.removeOrderListener?.();
    this.pendingRequests.forEach(({ reject, timeoutHandle }, clientOrderId) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`[COMB] Disposed before receiving update (clientOrderId=${clientOrderId})`));
    });
    this.pendingRequests.clear();
    this.subscribers.clear();
  }

  private _handleOrderUpdate(update: IWSOrderUpdate) {
    this.subscribers.forEach((listener) => {
      try { listener(update); } catch (error) { console.error("[COMB] Order update listener error:", error); }
    });
    const pending = this.pendingRequests.get(update.clientOrderId);
    if (!pending) return;
    if (update.orderStatus === "filled") {
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
        this.pendingRequests.delete(update.clientOrderId);
      }
      pending.resolve(update);
      return;
    }
    if (FAILURE_STATUSES.has(update.orderStatus)) {
      const error = new Error(`[COMB] Order ${update.clientOrderId} ended with status ${update.orderStatus}`);
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
        this.pendingRequests.delete(update.clientOrderId);
      }
      pending.reject(error);
    }
  }
}

export default CombOrderWatcher;
