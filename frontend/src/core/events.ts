/** Tiny event bus. A failing listener is dropped so one bad subscriber cannot break the rest. */
export type Listener<T = any> = (data: T) => void;

export class Emitter<T = any> {
  private listeners = new Set<Listener<T>>();

  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(data: T): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(data);
      } catch (e: any) {
        console.error("[ScholarPi] event listener failed", e);
        if (/dead|detached/i.test(String(e?.message))) this.listeners.delete(fn);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface GlobalEvent {
  type: string;
  [k: string]: any;
}

/** App-wide events (annotation created, session list changed, settings changed…). */
export const globalEvents = new Emitter<GlobalEvent>();
