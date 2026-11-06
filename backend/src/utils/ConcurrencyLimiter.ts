export class ConcurrencyLimiter {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Concurrency must be a positive integer.");
    }
  }

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    await new Promise<void>(resolve => {
      const start = () => {
        this.active += 1;
        resolve();
      };
      if (this.active < this.maximum) {
        start();
      } else {
        this.pending.push(start);
      }
    });

    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.pending.shift()?.();
    }
  }
}

export class ReadWriteLock {
  private readers = 0;
  private writing = false;
  private readonly pending: Array<{ write: boolean; start: () => void }> = [];

  get idle(): boolean {
    return this.readers === 0 && !this.writing && this.pending.length === 0;
  }

  read<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.run(false, operation);
  }

  write<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.run(true, operation);
  }

  private async run<Result>(write: boolean, operation: () => Promise<Result>): Promise<Result> {
    await new Promise<void>(resolve => {
      this.pending.push({ write, start: resolve });
      this.startPending();
    });
    try {
      return await operation();
    } finally {
      if (write) {
        this.writing = false;
      } else {
        this.readers -= 1;
      }
      this.startPending();
    }
  }

  private startPending(): void {
    if (this.writing) {
      return;
    }
    if (this.pending[0]?.write) {
      if (this.readers === 0) {
        this.writing = true;
        this.pending.shift()?.start();
      }
      return;
    }
    while (this.pending.length > 0 && !this.pending[0].write) {
      this.readers += 1;
      this.pending.shift()?.start();
    }
  }
}
