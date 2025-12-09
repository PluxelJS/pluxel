// file: src/ultra-fsm.ts
export type AnyFn = (...args: any[]) => any;

export type HookFn = (info: Readonly<{
  state: number;
  from: number;
  to: number;
  event: number;
  signal?: AbortSignal;
}>) => void | Promise<void>;

export type ILogger = Partial<typeof console> & {
  error(...data: unknown[]): void;
};

export interface UltraDef {
  readonly init: number;
  readonly stateCount: number;
  readonly eventCount: number;

  // size = stateCount * eventCount
  readonly next: Int32Array;     // to-state or -1
  readonly cbId: Int32Array;     // callback pool index or -1

  // size = stateCount
  readonly enterId: Int32Array;  // hook pool index or -1
  readonly exitId: Int32Array;   // hook pool index or -1
  readonly hasOutgoing: Uint8Array; // 1/0

  // dense pools (no holes)
  readonly callbacks: readonly AnyFn[];
  readonly hooks: readonly HookFn[];

  readonly abortOnStateChange: boolean;
}

const errNoTran = (from: number, event: number) =>
  `No transition: from ${from} event ${event}`;

type HookCtx = {
	state: number
	from: number
	to: number
	event: number
	signal?: AbortSignal
}

export class UltraMachine {
  private _s: number;
  private _abort: AbortController | null;
  private readonly logger: ILogger;

  // cache fields for JIT-friendliness (avoid nested property lookups)
  private readonly next: Int32Array;
  private readonly cbId: Int32Array;
  private readonly enterId: Int32Array;
  private readonly exitId: Int32Array;
  private readonly hasOutgoing: Uint8Array;
  private readonly callbacks: readonly AnyFn[];
  private readonly hooks: readonly HookFn[];
  private readonly eventCount: number;
  private readonly abortOnStateChange: boolean;
  private readonly hookCtx: HookCtx = {
    state: 0,
    from: 0,
    to: 0,
    event: 0,
    signal: undefined,
  };

  constructor(def: UltraDef, logger: ILogger = console) {
    this.logger = logger;
    this._s = def.init | 0;
    this._abort = def.abortOnStateChange ? new AbortController() : null;

    this.next = def.next;
    this.cbId = def.cbId;
    this.enterId = def.enterId;
    this.exitId = def.exitId;
    this.hasOutgoing = def.hasOutgoing;
    this.callbacks = def.callbacks;
    this.hooks = def.hooks;
    this.eventCount = def.eventCount | 0;
    this.abortOnStateChange = def.abortOnStateChange;
  }

  getState(): number { return this._s; }
  getSignal(): AbortSignal | undefined { return this._abort?.signal; }

  can(event: number): boolean {
    const idx = this._s * this.eventCount + event;
    return this.next[idx] !== -1;
  }

  isFinal(): boolean {
    return this.hasOutgoing[this._s] === 0;
  }

  async dispatch(event: number, ...args: any[]): Promise<void> {
    const from = this._s;
    const idx = from * this.eventCount + event;

    const to = this.next[idx];
    if (to === -1) {
      const msg = errNoTran(from, event);
      this.logger.error(msg);
      throw new Error(msg);
    }

    // Abort lifecycle
    let nextAbort: AbortController | null = null;
    if (this.abortOnStateChange) {
      const ab = this._abort;
      if (ab) ab.abort();
      nextAbort = new AbortController();
    }

    // Exit hook
    const exitHId = this.exitId[from];
    if (exitHId !== -1) {
      try {
        const ctx = this.hookCtx;
        ctx.state = from;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = undefined;
        await Promise.resolve(
          this.hooks[exitHId](ctx)
        );
      } catch (e) {
        this.logger.error("Exception in onExit hook", e);
        throw e;
      }
    }

    // Commit state
    this._s = to;
    if (nextAbort) this._abort = nextAbort;

    // Enter hook
    const enterHId = this.enterId[to];
    if (enterHId !== -1) {
      try {
        const ctx = this.hookCtx;
        ctx.state = to;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = this._abort?.signal;
        await Promise.resolve(
          this.hooks[enterHId](ctx)
        );
      } catch (e) {
        this.logger.error("Exception in onEnter hook", e);
        throw e;
      }
    }

    // Transition callback
    const cbIdx = this.cbId[idx];
    if (cbIdx !== -1) {
      try {
        await Promise.resolve(this.callbacks[cbIdx](...args));
      } catch (e) {
        this.logger.error("Exception in transition callback", e);
        throw e;
      }
    }
  }

  dispatchAsync(event: number, ...args: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        this.dispatch(event, ...args).then(resolve, reject);
      });
    });
  }
}

export class UltraMachineSync {
  private _s: number;
  private _abort: AbortController | null;
  private readonly logger: ILogger;

  // cache fields for JIT-friendliness
  private readonly next: Int32Array;
  private readonly cbId: Int32Array;
  private readonly enterId: Int32Array;
  private readonly exitId: Int32Array;
  private readonly hasOutgoing: Uint8Array;
  private readonly callbacks: readonly AnyFn[];
  private readonly hooks: readonly HookFn[];
  private readonly eventCount: number;
  private readonly abortOnStateChange: boolean;
  private readonly hookCtx: HookCtx = {
    state: 0,
    from: 0,
    to: 0,
    event: 0,
    signal: undefined,
  };

  constructor(def: UltraDef, logger: ILogger = console) {
    this.logger = logger;
    this._s = def.init | 0;
    this._abort = def.abortOnStateChange ? new AbortController() : null;

    this.next = def.next;
    this.cbId = def.cbId;
    this.enterId = def.enterId;
    this.exitId = def.exitId;
    this.hasOutgoing = def.hasOutgoing;
    this.callbacks = def.callbacks;
    this.hooks = def.hooks;
    this.eventCount = def.eventCount | 0;
    this.abortOnStateChange = def.abortOnStateChange;
  }

  getState(): number { return this._s; }
  getSignal(): AbortSignal | undefined { return this._abort?.signal; }

  can(event: number): boolean {
    const idx = this._s * this.eventCount + event;
    return this.next[idx] !== -1;
  }

  isFinal(): boolean {
    return this.hasOutgoing[this._s] === 0;
  }

  syncDispatch(event: number, ...args: any[]): boolean {
    const from = this._s;
    const idx = from * this.eventCount + event;

    const to = this.next[idx];
    if (to === -1) {
      this.logger.error(errNoTran(from, event));
      return false;
    }

    let nextAbort: AbortController | null = null;
    if (this.abortOnStateChange) {
      const ab = this._abort;
      if (ab) ab.abort();
      nextAbort = new AbortController();
    }

    try {
      const exitHId = this.exitId[from];
      if (exitHId !== -1) {
        const ctx = this.hookCtx;
        ctx.state = from;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = undefined;
        this.hooks[exitHId](ctx);
      }

      this._s = to;
      if (nextAbort) this._abort = nextAbort;

      const enterHId = this.enterId[to];
      if (enterHId !== -1) {
        const ctx = this.hookCtx;
        ctx.state = to;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = this._abort?.signal;
        this.hooks[enterHId](ctx);
      }

      const cbIdx = this.cbId[idx];
      if (cbIdx !== -1) {
        this.callbacks[cbIdx](...args);
      }

      return true;
    } catch (e) {
      this._s = from;
      this.logger.error("Exception in sync dispatch", e);
      throw e;
    }
  }
}
