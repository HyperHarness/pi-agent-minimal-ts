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
  private flushing = false;

  constructor(private readonly options: StreamUpdaterOptions) {}

  push(text: string): void {
    this.currentText = this.normalize(text);
    if (!this.options.enabled) {
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.options.intervalMs);
    }
  }

  async complete(text: string): Promise<void> {
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
    if (this.flushing) {
      return;
    }
    if (!force && this.currentText === this.lastFlushedText) {
      return;
    }
    if (!this.currentText) {
      return;
    }

    this.flushing = true;
    try {
      await this.options.patchMessage(this.currentText);
      this.lastFlushedText = this.currentText;
    } finally {
      this.flushing = false;
    }
  }
}
