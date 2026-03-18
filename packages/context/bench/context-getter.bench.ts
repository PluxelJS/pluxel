import { bench, describe } from 'vitest'
import { Context, type ServiceClass } from '@pluxel/context'

type TestServiceCtor = new (ctx: unknown, cfg?: unknown) => object
type TestServiceClass = ServiceClass<TestServiceCtor>
const asTestServiceClass = (ctor: unknown) => ctor as TestServiceClass

declare module '@pluxel/context' {
	interface Context {
		benchSvc: BenchSvc
		benchIsoSvc: BenchIsoSvc
		benchPing(): void
	}
	namespace Context {
		interface Services {
			benchSvc: BenchSvc
			benchIsoSvc: BenchIsoSvc
		}
	}
}

class BenchSvc {
	static key = 'benchSvc' as const
	static methods = ['benchPing'] as const
	constructor(public ctx: Context) {}
	benchPing() {}
}
Context.registerService(asTestServiceClass(BenchSvc))

class BenchIsoSvc {
	static key = 'benchIsoSvc' as const
	constructor(public ctx: Context) {}
}
Context.registerService(asTestServiceClass(BenchIsoSvc))

/* -------------------------------------------------------------------------- */
/* Algorithm-level baseline vs current                                        */
/* -------------------------------------------------------------------------- */

type CtxLike = {
	root: CtxLike
	name?: string
	config: Record<string, unknown>
	mapping: Record<symbol, symbol>
	instances: Record<symbol, unknown>
}

type AnyCtor = new (ctx: any, cfg?: any) => any

const makeCtxGraph = () => {
	const skShared = Symbol('BenchShared')
	const skIso = Symbol('BenchIso')

	class SharedSvc {
		constructor(
			public ctx: CtxLike,
			_cfg?: unknown,
		) {}
	}
	class IsoSvc {
		constructor(
			public ctx: CtxLike,
			_cfg?: unknown,
		) {}
	}

	const rootInstances: Record<symbol, unknown> = Object.create(null)
	const rootMapping: Record<symbol, symbol> = Object.create(null)
	rootMapping[skShared] = skShared
	rootMapping[skIso] = skIso

	const root: CtxLike = {
		root: undefined as unknown as CtxLike,
		name: 'root',
		config: { benchShared: {} },
		mapping: rootMapping,
		instances: rootInstances,
	}
	root.root = root

	const child: CtxLike = {
		root,
		name: 'child',
		config: root.config,
		mapping: root.mapping,
		instances: root.instances,
	}

	const isoInstances: Record<symbol, unknown> = Object.create(root.instances)
	const isoMapping: Record<symbol, symbol> = Object.create(root.mapping)
	isoMapping[skIso] = Symbol('BenchIso:inst')

	const iso: CtxLike = {
		root,
		name: 'iso',
		config: root.config,
		mapping: isoMapping,
		instances: isoInstances,
	}

	const isoChild: CtxLike = {
		root,
		name: 'iso.child',
		config: root.config,
		mapping: iso.mapping,
		instances: iso.instances,
	}

	return { skShared, skIso, SharedSvc, IsoSvc, root, child, iso, isoChild }
}

const getSvcOld = (ctx: CtxLike, sk: symbol, key: string, ctor: AnyCtor) => {
	const ik = ctx.mapping[sk] as symbol
	const store = ik === sk ? ctx.root.instances : ctx.instances
	let inst = store[ik] as { ctx: CtxLike } | undefined
	if (inst) {
		if (inst.ctx !== ctx) inst.ctx = ctx
		return inst
	}
	const cfg = ctx.config[key]
	inst = new ctor(ctx, cfg) as { ctx: CtxLike }
	inst.ctx = ctx
	store[ik] = inst
	return inst
}

const getSvcNew = (ctx: CtxLike, sk: symbol, key: string, ctor: AnyCtor) => {
	const ik = ctx.mapping[sk] as symbol
	let inst = ctx.instances[ik] as { ctx: CtxLike } | undefined
	if (inst) {
		if (inst.ctx !== ctx) inst.ctx = ctx
		return inst
	}
	const cfg = ctx.config[key]
	inst = new ctor(ctx, cfg) as { ctx: CtxLike }
	inst.ctx = ctx
	;(ik === sk ? ctx.root.instances : ctx.instances)[ik] = inst
	return inst
}

describe('Context getter micro-bench', () => {
	const root = new Context({ name: 'root' })
	const child = root.extend({ name: 'child' })
	const child2 = root.extend({ name: 'child2' })
	const iso = root.isolate([asTestServiceClass(BenchIsoSvc)], { name: 'iso' })
	const isoChild = iso.extend({ name: 'iso.child' })

	// Warm up (ensure instances exist and code paths are compiled)
	void root.benchSvc
	void root.benchIsoSvc
	void iso.benchIsoSvc
	void isoChild.benchIsoSvc
	void iso.benchSvc
	void isoChild.benchSvc
	root.benchPing()

	bench('getter hit (root, shared)', () => {
		void root.benchSvc
	})

	bench('getter hit (shared + ctx rebind: root<->child)', () => {
		void root.benchSvc
		void child.benchSvc
	})

	bench('getter hit (shared + ctx rebind: root<->child2)', () => {
		void root.benchSvc
		void child2.benchSvc
	})

	bench('getter hit (iso, isolated instance)', () => {
		void iso.benchIsoSvc
	})

	bench('getter hit (isolated + ctx rebind: iso<->iso child)', () => {
		void iso.benchIsoSvc
		void isoChild.benchIsoSvc
	})

	bench('getter hit (iso, shared service via proto chain)', () => {
		void iso.benchSvc
	})

	bench('getter hit (iso child, shared service via proto chain)', () => {
		void isoChild.benchSvc
	})

	bench('getter hit (iso shared + ctx rebind: iso<->iso child)', () => {
		void iso.benchSvc
		void isoChild.benchSvc
	})

	bench('method proxy (ctx.benchPing())', () => {
		root.benchPing()
	})

	const gOld = makeCtxGraph()
	const gNew = makeCtxGraph()

	// Warm: create instances so the benches measure the steady-state hit path.
	void getSvcOld(gOld.root, gOld.skShared, 'benchShared', gOld.SharedSvc)
	void getSvcOld(gOld.iso, gOld.skIso, 'benchIso', gOld.IsoSvc)
	void getSvcNew(gNew.root, gNew.skShared, 'benchShared', gNew.SharedSvc)
	void getSvcNew(gNew.iso, gNew.skIso, 'benchIso', gNew.IsoSvc)

	bench('algo old: hit (shared + rebind: root<->child)', () => {
		void getSvcOld(gOld.root, gOld.skShared, 'benchShared', gOld.SharedSvc)
		void getSvcOld(gOld.child, gOld.skShared, 'benchShared', gOld.SharedSvc)
	})

	bench('algo new: hit (shared + rebind: root<->child)', () => {
		void getSvcNew(gNew.root, gNew.skShared, 'benchShared', gNew.SharedSvc)
		void getSvcNew(gNew.child, gNew.skShared, 'benchShared', gNew.SharedSvc)
	})

	bench('algo old: hit (iso shared + rebind: root<->iso)', () => {
		void getSvcOld(gOld.root, gOld.skShared, 'benchShared', gOld.SharedSvc)
		void getSvcOld(gOld.iso, gOld.skShared, 'benchShared', gOld.SharedSvc)
	})

	bench('algo new: hit (iso shared + rebind: root<->iso)', () => {
		void getSvcNew(gNew.root, gNew.skShared, 'benchShared', gNew.SharedSvc)
		void getSvcNew(gNew.iso, gNew.skShared, 'benchShared', gNew.SharedSvc)
	})

	bench('algo old: hit (iso isolated + rebind: iso<->iso child)', () => {
		void getSvcOld(gOld.iso, gOld.skIso, 'benchIso', gOld.IsoSvc)
		void getSvcOld(gOld.isoChild, gOld.skIso, 'benchIso', gOld.IsoSvc)
	})

	bench('algo new: hit (iso isolated + rebind: iso<->iso child)', () => {
		void getSvcNew(gNew.iso, gNew.skIso, 'benchIso', gNew.IsoSvc)
		void getSvcNew(gNew.isoChild, gNew.skIso, 'benchIso', gNew.IsoSvc)
	})
})
