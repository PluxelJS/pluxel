// file: src/defineMachine.macro.ts
import { type AnyFn, type HookFn, type UltraDef, UltraMachine, UltraMachineSync } from './ultra-fsm'

type TransitionTuple<S extends string, E extends string> = readonly [
	from: S,
	event: E,
	to: S,
	cbName?: string,
]

export interface DefineMachineInput<
   States extends readonly string[],
   Events extends readonly string[],
> {
  states: States;
  events: Events;
  init: States[number];

  transitions: readonly TransitionTuple<States[number], Events[number]>[];

  hooks?: {
    enter?: Partial<Record<States[number], string>>;
    exit?: Partial<Record<States[number], string>>;
  };

  /**
   * 实现映射：
   * - 宏期：可用来把函数标识符收敛成函数池
   * - 运行期：同样可用，保证测试/开发不依赖宏也能跑
   */
  impl?: {
    callbacks?: Record<string, AnyFn>;
    hooks?: Record<string, HookFn>;
  };

  abortOnStateChange?: boolean;

  /**
   * 默认 true：同一 (from,event) 重复时直接报错
   */
	strictDuplicateEdge?: boolean;
}

export interface DefineMachineResult<SNames extends string, ENames extends string> {
	S: Record<SNames, number>
	E: Record<ENames, number>
	Def: UltraDef

	createMachine: (logger?: ConstructorParameters<typeof UltraMachine>[1]) => UltraMachine
	createMachineSync: (logger?: ConstructorParameters<typeof UltraMachineSync>[1]) => UltraMachineSync
}

type CallbackNames<T extends readonly TransitionTuple<any, any>[]> = Extract<
	T[number][3],
	string
>
type HookNames<H> = H extends { enter?: Record<string, infer N1>; exit?: Record<string, infer N2> }
	? Extract<N1 | N2, string>
	: never

type ImplFor<Cb extends string, Hook extends string> =
	(Cb extends never ? { callbacks?: Record<Cb, AnyFn> } : { callbacks: Record<Cb, AnyFn> }) &
		(Hook extends never ? { hooks?: Record<Hook, HookFn> } : { hooks: Record<Hook, HookFn> })

export interface BakedMachine<
	SNames extends string,
	ENames extends string,
	CbNames extends string,
	HookNames extends string,
> {
	S: Record<SNames, number>
	E: Record<ENames, number>
	def: {
		init: number
		stateCount: number
		eventCount: number
		next: number[]
		cbId: number[]
		enterId: number[]
		exitId: number[]
		hasOutgoing: number[]
		callbackNames: readonly CbNames[]
		hookNames: readonly HookNames[]
		abortOnStateChange: boolean
	}
}

export type MachineImpl<M extends BakedMachine<any, any, any, any>> = ImplFor<
	M['def']['callbackNames'][number],
	M['def']['hookNames'][number]
>

function buildIdMap(names: readonly string[]) {
	const m = new Map<string, number>()
	for (let i = 0; i < names.length; i++) m.set(names[i], i)
	return m
}

function uniqPush<T extends string>(arr: T[], seen: Set<string>, name: T) {
	if (!seen.has(name)) {
		seen.add(name)
		arr.push(name)
	}
}

function bakeDefinition<
	const States extends readonly string[],
	const Events extends readonly string[],
	const Transitions extends readonly TransitionTuple<States[number], Events[number]>[],
	const HooksInput extends DefineMachineInput<States, Events>['hooks'],
	const Cb extends string = CallbackNames<Transitions>,
	const Hook extends string = HookNames<HooksInput>,
>(
	input: Omit<DefineMachineInput<States, Events>, 'transitions' | 'hooks' | 'impl'> & {
		transitions: Transitions
		hooks?: HooksInput
		impl?: ImplFor<Cb, Hook>
	},
): BakedMachine<States[number], Events[number], Cb, Hook> {
	const {
		states,
		events,
		init,
		transitions,
		hooks,
		abortOnStateChange = false,
		strictDuplicateEdge = true,
	} = input

	const stateCount = states.length | 0
	const eventCount = events.length | 0

	// --- build name->id maps ---
	const stateId = buildIdMap(states)
	const eventId = buildIdMap(events)

	const initId = stateId.get(init)
	if (initId == null) {
		throw new Error(`Invalid init state: ${init}`)
	}

	// --- exportable S/E objects ---
	const S = Object.create(null) as Record<States[number], number>
	const E = Object.create(null) as Record<Events[number], number>
	for (let i = 0; i < states.length; i++) (S as any)[states[i]] = i
	for (let i = 0; i < events.length; i++) (E as any)[events[i]] = i

	// --- collect callback/hook names in deterministic order ---
	const cbNames: Cb[] = [] as unknown as Cb[]
	const cbSeen = new Set<string>()

	const enterNames: Hook[] = [] as unknown as Hook[]
	const enterSeen = new Set<string>()

	const exitNames: Hook[] = [] as unknown as Hook[]
	const exitSeen = new Set<string>()

	for (const t of transitions) {
		const cb = t[3]
		if (cb) uniqPush(cbNames, cbSeen, cb)
	}

	const enterMap = hooks?.enter ?? {}
	const exitMap = hooks?.exit ?? {}

	for (const k in enterMap) {
		const name = (enterMap as any)[k]
		if (name) uniqPush(enterNames, enterSeen, name)
	}
	for (const k in exitMap) {
		const name = (exitMap as any)[k]
		if (name) uniqPush(exitNames, exitSeen, name)
	}

	// hook pool is enterNames + exitNames (dedup across both)
	const hookNames: Hook[] = [] as unknown as Hook[]
	const hookSeen = new Set<string>()
	for (const n of enterNames) uniqPush(hookNames, hookSeen, n)
	for (const n of exitNames) uniqPush(hookNames, hookSeen, n)

	const cbNameToId = new Map<string, number>()
	for (let i = 0; i < cbNames.length; i++) cbNameToId.set(cbNames[i], i)

	const hookNameToId = new Map<string, number>()
	for (let i = 0; i < hookNames.length; i++) hookNameToId.set(hookNames[i], i)

	// --- tables ---
	const size = (stateCount * eventCount) | 0
	const next = new Int32Array(size)
	const cbId = new Int32Array(size)
	next.fill(-1)
	cbId.fill(-1)

	const hasOutgoing = new Uint8Array(stateCount) // default 0

	// detect duplicates
	const edgeSeen = strictDuplicateEdge ? new Set<number>() : null

	for (const tr of transitions) {
		const [fromN, evtN, toN, cbN] = tr

		const from = stateId.get(fromN)
		const evt = eventId.get(evtN)
		const to = stateId.get(toN)

		if (from == null) throw new Error(`Invalid fromState: ${fromN}`)
		if (evt == null) throw new Error(`Invalid event: ${evtN}`)
		if (to == null) throw new Error(`Invalid toState: ${toN}`)

		const idx = (from * eventCount + evt) | 0

		if (edgeSeen) {
			if (edgeSeen.has(idx)) {
				throw new Error(`Duplicate edge: (${fromN}, ${evtN})`)
			}
			edgeSeen.add(idx)
		}

		next[idx] = to
		hasOutgoing[from] = 1

		if (cbN) {
			const id = cbNameToId.get(cbN)
			if (id == null) throw new Error(`Callback name not registered: ${cbN}`)
			cbId[idx] = id
		}
	}

	const enterId = new Int32Array(stateCount)
	const exitId = new Int32Array(stateCount)
	enterId.fill(-1)
	exitId.fill(-1)

	for (const sName in enterMap) {
		const hookName = (enterMap as any)[sName] as string | undefined
		if (!hookName) continue
		const sid = stateId.get(sName)
		if (sid == null) throw new Error(`Invalid enter hook state: ${sName}`)
		const hid = hookNameToId.get(hookName)
		if (hid == null) throw new Error(`Invalid enter hook name: ${hookName}`)
		enterId[sid] = hid
	}

	for (const sName in exitMap) {
		const hookName = (exitMap as any)[sName] as string | undefined
		if (!hookName) continue
		const sid = stateId.get(sName)
		if (sid == null) throw new Error(`Invalid exit hook state: ${sName}`)
		const hid = hookNameToId.get(hookName)
		if (hid == null) throw new Error(`Invalid exit hook name: ${hookName}`)
		exitId[sid] = hid
	}

	return {
		S: S as any,
		E: E as any,
		def: {
			init: initId,
			stateCount,
			eventCount,
			next: Array.from(next),
			cbId: Array.from(cbId),
			enterId: Array.from(enterId),
			exitId: Array.from(exitId),
			hasOutgoing: Array.from(hasOutgoing),
			callbackNames: cbNames as readonly Cb[],
			hookNames: hookNames as readonly Hook[],
			abortOnStateChange,
		},
	}
}

export function hydrateMachine<
	const States extends string,
	const Events extends string,
	const Callbacks extends string,
	const Hooks extends string,
>(
	baked: BakedMachine<States, Events, Callbacks, Hooks>,
	impl: ImplFor<Callbacks, Hooks>,
): DefineMachineResult<States, Events> {
	const { def } = baked

	const callbacks: AnyFn[] = []
	const cbImpl = impl?.callbacks ?? Object.create(null)
	for (const name of def.callbackNames) {
		const fn = cbImpl[name]
		if (!fn) throw new Error(`Missing callback impl: ${name}`)
		callbacks.push(fn)
	}

	const hooksPool: HookFn[] = []
	const hookImpl = impl?.hooks ?? Object.create(null)
	for (const name of def.hookNames) {
		const fn = hookImpl[name]
		if (!fn) throw new Error(`Missing hook impl: ${name}`)
		hooksPool.push(fn)
	}

	const Def: UltraDef = {
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
		abortOnStateChange: def.abortOnStateChange,
	}

	// factories (宏期会把这段函数源码内联进产物)
	const createMachine = (logger?: any) => new UltraMachine(Def, logger)
	const createMachineSync = (logger?: any) => new UltraMachineSync(Def, logger)

	return { S: baked.S, E: baked.E, Def, createMachine, createMachineSync }
}

export function bakeMachine<
	const States extends readonly string[],
	const Events extends readonly string[],
	const Transitions extends readonly TransitionTuple<States[number], Events[number]>[],
	const HooksInput extends DefineMachineInput<States, Events>['hooks'],
	const Cb extends string = CallbackNames<Transitions>,
	const Hook extends string = HookNames<HooksInput>,
>(
	input: Omit<DefineMachineInput<States, Events>, 'transitions' | 'hooks' | 'impl'> & {
		transitions: Transitions
		hooks?: HooksInput
		impl?: ImplFor<Cb, Hook>
	},
): BakedMachine<States[number], Events[number], Cb, Hook> {
	return bakeDefinition(input)
}

export function defineMachine<
	const States extends readonly string[],
	const Events extends readonly string[],
	const Transitions extends readonly TransitionTuple<States[number], Events[number]>[],
	const HooksInput extends DefineMachineInput<States, Events>['hooks'],
	const Cb extends string = CallbackNames<Transitions>,
	const Hook extends string = HookNames<HooksInput>,
>(
	input: Omit<DefineMachineInput<States, Events>, 'transitions' | 'hooks' | 'impl'> & {
		transitions: Transitions
		hooks?: HooksInput
		impl: ImplFor<Cb, Hook>
	},
): DefineMachineResult<States[number], Events[number]> {
	const baked = bakeDefinition(input)
	return hydrateMachine(baked, input.impl)
}
