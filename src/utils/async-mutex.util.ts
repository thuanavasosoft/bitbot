export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolveNext = this.queue.shift();
      resolveNext?.();
      return;
    }

    this.locked = false;
  }
}
