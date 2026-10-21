export interface StreamUpdaterOptions {
  enabled: boolean;
  intervalMs: number;
  maxMessageLength: number;
  patchMessage: (content: string) => Promise<void>;
}

export class StreamUpdater {
  private currentText = '';
  private lastFlushedText = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private completed = false;

  constructor(private readonly options: StreamUpdaterOptions) {}

  push(text: string): void {
    if (this.completed) return;
    this.currentText = this.normalize(text);
    if (!this.options.enabled) {
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        // A failed intermediate patch stays unflushed and can be retried by
        // the next update. complete() still propagates a final patch failure.
        void this.flush().catch(() => {});
      }, this.options.intervalMs);
    }
  }

  async complete(text: string): Promise<void> {
    this.completed = true;
    this.currentText = this.normalize(text);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush(true);
  }

  private normalize(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= this.options.maxMessageLength) {
      return trimmed;
    }
    return `${trimmed.slice(0, this.options.maxMessageLength - 1)}…`;
  }

  private async flush(force = false): Promise<void> {
    while (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Retry the latest text after an earlier failed intermediate patch.
      }
    }
    if (!force && this.currentText === this.lastFlushedText) {
      return;
    }
    if (!this.currentText) {
      return;
    }

    const text = this.currentText;
    const pending = Promise.resolve().then(() => this.options.patchMessage(text)).then(() => {
      this.lastFlushedText = text;
    });
    this.inFlight = pending;
    try {
      await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
    if (force && this.currentText !== this.lastFlushedText) await this.flush(true);
  }
}
