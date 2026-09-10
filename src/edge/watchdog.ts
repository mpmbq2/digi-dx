// PttWatchdog — Fail-safe PTT monitor for the unitary edge client (R4, AE1).
//
// Protects radio equipment and amplifiers by ensuring physical PTT is never held
// active if the controlling cloud or client stream drops. The timer slides forward
// each time pet() is called. If the timeout (default 500ms) elapses while armed,
// onTimeout() is invoked immediately to de-assert PTT and clear transmit buffers.

export interface PttWatchdogOptions {
  timeoutMs?: number;
  onTimeout: () => Promise<void> | void;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export class PttWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;
  private readonly onTimeout: () => Promise<void> | void;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private armed = false;
  private timedOut = false;

  constructor(options: PttWatchdogOptions) {
    this.timeoutMs = options.timeoutMs ?? 500;
    this.onTimeout = options.onTimeout;
    this.logger = options.logger ?? console;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get hasTimedOut(): boolean {
    return this.timedOut;
  }

  get currentTimeoutMs(): number {
    return this.timeoutMs;
  }

  arm(): void {
    this.armed = true;
    this.timedOut = false;
    this.pet();
  }

  pet(): void {
    if (!this.armed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.triggerTimeout();
    }, this.timeoutMs);
  }

  disarm(): void {
    this.armed = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private triggerTimeout(): void {
    this.armed = false;
    this.timedOut = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.warn(`[fail-safe] PTT watchdog timeout (${this.timeoutMs}ms) exceeded: dropping PTT immediately`);
    try {
      void this.onTimeout();
    } catch (error) {
      this.logger.error(`[fail-safe] error during watchdog abort: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
