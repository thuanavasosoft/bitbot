import ExchangeService from "@/services/exchange-service/exchange-service";
import { IWSOrderUpdate } from "@/services/exchange-service/exchange-type";

type PendingRequest = {
  resolve: (update: IWSOrderUpdate) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
};

const FAILURE_STATUSES = new Set(["canceled", "partially_filled_canceled", "unknown"]);

export type OrderWatcherResult = IWSOrderUpdate;

class BBOrderWatcher {
  private pendingRequests = new Map<string, PendingRequest>();
  private subscribers = new Set<(update: IWSOrderUpdate) => void>();
  private removeOrderListener?: () => void;
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = Math.max(1000, options?.defaultTimeoutMs ?? 60_000);
    this.removeOrderListener = ExchangeService.hookOrderListener((update) => this._handleOrderUpdate(update));
  }

  waitForFill(clientOrderId: string, timeoutMs?: number): Promise<OrderWatcherResult> {
    if (!clientOrderId) {
      return Promise.reject(new Error("[BBOrderWatcher] Invalid clientOrderId supplied"));
    }

    if (this.pendingRequests.has(clientOrderId)) {
      return Promise.reject(new Error(`[BBOrderWatcher] Already awaiting clientOrderId ${clientOrderId}`));
    }

    const waitTimeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<OrderWatcherResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(clientOrderId);
        reject(new Error(`[BBOrderWatcher] Timed out waiting for fill (clientOrderId=${clientOrderId})`));
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
      reject(new Error(`[BBOrderWatcher] Disposed before receiving update (clientOrderId=${clientOrderId})`));
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
      const error = new Error(`[BBOrderWatcher] Order ${update.clientOrderId} ended with status ${update.orderStatus}`);
      this._rejectPending(update.clientOrderId, pending, error);
    }
  }

  private _notifySubscribers(update: IWSOrderUpdate) {
    this.subscribers.forEach((listener) => {
      try {
        listener(update);
      } catch (error) {
        console.error("[BBOrderWatcher] Order update listener error:", error);
      }
    });
  }

  private _resolvePending(clientOrderId: string, pending: PendingRequest, update: IWSOrderUpdate) {
    clearTimeout(pending.timeoutHandle);
    this.pendingRequests.delete(clientOrderId);
    pending.resolve(update);
  }

  private _rejectPending(clientOrderId: string, pending: PendingRequest, error: Error) {
    clearTimeout(pending.timeoutHandle);
    this.pendingRequests.delete(clientOrderId);
    pending.reject(error);
  }
}

export default BBOrderWatcher;
