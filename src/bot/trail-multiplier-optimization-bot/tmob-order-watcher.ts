import ExchangeService from "@/services/exchange-service/exchange-service";
import { IWSOrderUpdate } from "@/services/exchange-service/exchange-type";

type PendingRequest = {
  resolve: (update: IWSOrderUpdate) => void;
  reject: (error: Error) => void;
  timeoutHandle?: NodeJS.Timeout;
  earlyResult?: { type: "success"; value: IWSOrderUpdate } | { type: "error"; value: Error };
};

const FAILURE_STATUSES = new Set(["canceled", "partially_filled_canceled", "unknown"]);

export type TMOBOrderWatcherResult = IWSOrderUpdate;

export type TMOBPreRegisteredOrder = {
  wait: (timeoutMs?: number) => Promise<TMOBOrderWatcherResult>;
  cancel: () => void;
};

class TMOBOrderWatcher {
  private pendingRequests = new Map<string, PendingRequest>();
  private subscribers = new Set<(update: IWSOrderUpdate) => void>();
  private removeOrderListener?: () => void;
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = Math.max(1000, options?.defaultTimeoutMs ?? 10_000);
    this.removeOrderListener = ExchangeService.hookOrderListener((update) => this._handleOrderUpdate(update));
  }

  preRegister(clientOrderId: string): TMOBPreRegisteredOrder {
    if (!clientOrderId) {
      return {
        wait: () => Promise.reject(new Error("[TMOBOrderWatcher] Invalid clientOrderId supplied")),
        cancel: () => { },
      };
    }

    if (this.pendingRequests.has(clientOrderId)) {
      return {
        wait: () =>
          Promise.reject(new Error(`[TMOBOrderWatcher] Already awaiting clientOrderId ${clientOrderId}`)),
        cancel: () => { },
      };
    }

    let resolvePromise: (update: IWSOrderUpdate) => void;
    let rejectPromise: (error: Error) => void;

    const promise = new Promise<TMOBOrderWatcherResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const pending: PendingRequest = {
      resolve: resolvePromise!,
      reject: rejectPromise!,
    };

    this.pendingRequests.set(clientOrderId, pending);

    const wait = (timeoutMs?: number): Promise<TMOBOrderWatcherResult> => {
      if (pending.earlyResult) {
        this.pendingRequests.delete(clientOrderId);
        if (pending.earlyResult.type === "success") {
          return Promise.resolve(pending.earlyResult.value);
        } else {
          return Promise.reject(pending.earlyResult.value);
        }
      }

      const waitTimeout = timeoutMs ?? this.defaultTimeoutMs;
      pending.timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(clientOrderId);
        rejectPromise(
          new Error(`[TMOBOrderWatcher Pre Register] Timed out waiting for fill (clientOrderId=${clientOrderId})`)
        );
      }, waitTimeout);

      return promise;
    };

    const cancel = () => {
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
      this.pendingRequests.delete(clientOrderId);
    };

    return { wait, cancel };
  }

  waitForFill(clientOrderId: string, timeoutMs?: number): Promise<TMOBOrderWatcherResult> {
    if (!clientOrderId) {
      return Promise.reject(new Error("[TMOBOrderWatcher] Invalid clientOrderId supplied"));
    }

    if (this.pendingRequests.has(clientOrderId)) {
      return Promise.reject(new Error(`[TMOBOrderWatcher] Already awaiting clientOrderId ${clientOrderId}`));
    }

    const waitTimeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<TMOBOrderWatcherResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(clientOrderId);
        reject(
          new Error(`[TMOBOrderWatcher Wait For Fill] Timed out waiting for fill (clientOrderId=${clientOrderId})`)
        );
      }, waitTimeout);

      this.pendingRequests.set(clientOrderId, { resolve, reject, timeoutHandle });
    });
  }

  onOrderUpdate(listener: (update: IWSOrderUpdate) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  dispose() {
    this.removeOrderListener?.();
    this.pendingRequests.forEach(({ reject, timeoutHandle }, clientOrderId) => {
      clearTimeout(timeoutHandle);
      reject(
        new Error(`[TMOBOrderWatcher] Disposed before receiving update (clientOrderId=${clientOrderId})`)
      );
    });
    this.pendingRequests.clear();
    this.subscribers.clear();
  }

  private _handleOrderUpdate(update: IWSOrderUpdate) {
    this._notifySubscribers(update);

    const pending = this.pendingRequests.get(update.clientOrderId);
    if (!pending) return;

    if (update.orderStatus === "filled") {
      this._resolvePending(update.clientOrderId, pending, update);
      return;
    }

    if (FAILURE_STATUSES.has(update.orderStatus)) {
      const error = new Error(
        `[TMOBOrderWatcher] Order ${update.clientOrderId} ended with status ${update.orderStatus}`
      );
      this._rejectPending(update.clientOrderId, pending, error);
    }
  }

  private _notifySubscribers(update: IWSOrderUpdate) {
    this.subscribers.forEach((listener) => {
      try {
        listener(update);
      } catch (error) {
        console.error("[TMOBOrderWatcher] Order update listener error:", error);
      }
    });
  }

  private _resolvePending(clientOrderId: string, pending: PendingRequest, update: IWSOrderUpdate) {
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
      this.pendingRequests.delete(clientOrderId);
      pending.resolve(update);
    } else {
      pending.earlyResult = { type: "success", value: update };
    }
  }

  private _rejectPending(clientOrderId: string, pending: PendingRequest, error: Error) {
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
      this.pendingRequests.delete(clientOrderId);
      pending.reject(error);
    } else {
      pending.earlyResult = { type: "error", value: error };
    }
  }
}

export default TMOBOrderWatcher;
