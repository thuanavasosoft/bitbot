/**
 * Fixed-size ring buffer. Push overwrites the oldest element. O(1) push, O(n) toArray.
 */
export class RingBuffer<T> {
  private buffer: T[];
  private writeIndex: number = 0;
  private readonly size: number;

  private constructor(size: number, initialItems: T[]) {
    this.size = size;
    this.buffer = [...initialItems];
    this.writeIndex = 0;
  }

  static fromArray<T>(items: T[]): RingBuffer<T> {
    if (items.length === 0) throw new Error("RingBuffer.fromArray requires at least one item");
    return new RingBuffer<T>(items.length, items);
  }

  /**
   * Creates a RingBuffer with fixed capacity. Takes the last `capacity` items from initialItems.
   * Requires initialItems.length >= capacity.
   */
  static withCapacity<T>(capacity: number, initialItems: T[]): RingBuffer<T> {
    if (capacity <= 0) throw new Error("RingBuffer.withCapacity requires capacity > 0");
    if (initialItems.length < capacity) {
      throw new Error(`RingBuffer.withCapacity needs at least ${capacity} items, got ${initialItems.length}`);
    }
    const items = initialItems.slice(-capacity);
    return new RingBuffer<T>(capacity, items);
  }

  push(item: T): void {
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.size;
  }

  toArray(): T[] {
    return [...this.buffer.slice(this.writeIndex), ...this.buffer.slice(0, this.writeIndex)];
  }

  get length(): number {
    return this.size;
  }
}
