// @bun
// fsm/ultra-fsm.ts
var errNoTran = (from, event) => `No transition: from ${from} event ${event}`;

class UltraMachine {
  _s;
  _abort;
  logger;
  next;
  cbId;
  enterId;
  exitId;
  hasOutgoing;
  callbacks;
  hooks;
  eventCount;
  abortOnStateChange;
  hookCtx = {
    state: 0,
    from: 0,
    to: 0,
    event: 0,
    signal: undefined
  };
  constructor(def, logger = console) {
    this.logger = logger;
    this._s = def.init | 0;
    this._abort = def.abortOnStateChange ? new AbortController : null;
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
  getState() {
    return this._s;
  }
  getSignal() {
    return this._abort?.signal;
  }
  can(event) {
    const idx = this._s * this.eventCount + event;
    return this.next[idx] !== -1;
  }
  isFinal() {
    return this.hasOutgoing[this._s] === 0;
  }
  async dispatch(event, ...args) {
    const from = this._s;
    const idx = from * this.eventCount + event;
    const to = this.next[idx];
    if (to === -1) {
      const msg = errNoTran(from, event);
      this.logger.error(msg);
      throw new Error(msg);
    }
    let nextAbort = null;
    if (this.abortOnStateChange) {
      const ab = this._abort;
      if (ab)
        ab.abort();
      nextAbort = new AbortController;
    }
    const exitHId = this.exitId[from];
    if (exitHId !== -1) {
      try {
        const ctx = this.hookCtx;
        ctx.state = from;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = undefined;
        await Promise.resolve(this.hooks[exitHId](ctx));
      } catch (e) {
        this.logger.error("Exception in onExit hook", e);
        throw e;
      }
    }
    this._s = to;
    if (nextAbort)
      this._abort = nextAbort;
    const enterHId = this.enterId[to];
    if (enterHId !== -1) {
      try {
        const ctx = this.hookCtx;
        ctx.state = to;
        ctx.from = from;
        ctx.to = to;
        ctx.event = event;
        ctx.signal = this._abort?.signal;
        await Promise.resolve(this.hooks[enterHId](ctx));
      } catch (e) {
        this.logger.error("Exception in onEnter hook", e);
        throw e;
      }
    }
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
  dispatchAsync(event, ...args) {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        this.dispatch(event, ...args).then(resolve, reject);
      });
    });
  }
}

class UltraMachineSync {
  _s;
  _abort;
  logger;
  next;
  cbId;
  enterId;
  exitId;
  hasOutgoing;
  callbacks;
  hooks;
  eventCount;
  abortOnStateChange;
  hookCtx = {
    state: 0,
    from: 0,
    to: 0,
    event: 0,
    signal: undefined
  };
  constructor(def, logger = console) {
    this.logger = logger;
    this._s = def.init | 0;
    this._abort = def.abortOnStateChange ? new AbortController : null;
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
  getState() {
    return this._s;
  }
  getSignal() {
    return this._abort?.signal;
  }
  can(event) {
    const idx = this._s * this.eventCount + event;
    return this.next[idx] !== -1;
  }
  isFinal() {
    return this.hasOutgoing[this._s] === 0;
  }
  syncDispatch(event, ...args) {
    const from = this._s;
    const idx = from * this.eventCount + event;
    const to = this.next[idx];
    if (to === -1) {
      this.logger.error(errNoTran(from, event));
      return false;
    }
    let nextAbort = null;
    if (this.abortOnStateChange) {
      const ab = this._abort;
      if (ab)
        ab.abort();
      nextAbort = new AbortController;
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
      if (nextAbort)
        this._abort = nextAbort;
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

// fsm/defineMachine.macro.ts
function hydrateMachine(baked, impl) {
  const { def } = baked;
  const callbacks = [];
  const cbImpl = impl?.callbacks ?? Object.create(null);
  for (const name of def.callbackNames) {
    const fn = cbImpl[name];
    if (!fn)
      throw new Error(`Missing callback impl: ${name}`);
    callbacks.push(fn);
  }
  const hooksPool = [];
  const hookImpl = impl?.hooks ?? Object.create(null);
  for (const name of def.hookNames) {
    const fn = hookImpl[name];
    if (!fn)
      throw new Error(`Missing hook impl: ${name}`);
    hooksPool.push(fn);
  }
  const Def = {
    init: def.init,
    stateCount: def.stateCount,
    eventCount: def.eventCount,
    next: Int32Array.from(def.next),
    cbId: Int32Array.from(def.cbId),
    enterId: Int32Array.from(def.enterId),
    exitId: Int32Array.from(def.exitId),
    hasOutgoing: Uint8Array.from(def.hasOutgoing),
    callbacks,
    hooks: hooksPool,
    abortOnStateChange: def.abortOnStateChange
  };
  const createMachine = (logger) => new UltraMachine(Def, logger);
  const createMachineSync = (logger) => new UltraMachineSync(Def, logger);
  return { S: baked.S, E: baked.E, Def, createMachine, createMachineSync };
}

// fsm/tests/fixtures/macro-entry.ts
function onStart(name) {}
function onEnterRunning(info) {
  const { signal } = info;
  if (!signal)
    return;
  const t = setInterval(() => {}, 5);
  signal.addEventListener("abort", () => clearInterval(t), { once: true });
}
var impl = {
  callbacks: { onStart },
  hooks: { onEnterRunning }
};
var fsm = hydrateMachine({
  S: {
    idle: 0,
    running: 1,
    stopped: 2
  },
  E: {
    start: 0,
    stop: 1
  },
  def: {
    init: 0,
    stateCount: 3,
    eventCount: 2,
    next: [
      1,
      -1,
      -1,
      2,
      -1,
      -1
    ],
    cbId: [
      0,
      -1,
      -1,
      -1,
      -1,
      -1
    ],
    enterId: [
      -1,
      0,
      -1
    ],
    exitId: [
      -1,
      -1,
      -1
    ],
    hasOutgoing: [
      1,
      1,
      0
    ],
    callbackNames: [
      "onStart"
    ],
    hookNames: [
      "onEnterRunning"
    ],
    abortOnStateChange: true
  }
}, impl);
export {
  onStart,
  onEnterRunning,
  fsm
};
