import { Bench } from 'tinybench'
import {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	type Context,
} from '../src/kernel.ts'
import { Context as LegacyContext } from '../legacy/src/Context.ts'
import type { ServiceClass as LegacyServiceClass } from '../legacy/src/service-types.ts'

type AnyLegacyService = new (ctx: LegacyContext, cfg?: unknown) => object
const asLegacyServiceClass = (ctor: AnyLegacyService): LegacyServiceClass<AnyLegacyService> =>
	ctor as LegacyServiceClass<AnyLegacyService>

class LegacyRootService {
	static key = 'comparisonRoot' as const
	static scope = 'root' as const
	ctx: LegacyContext
	constructor(ctx: LegacyContext) {
		this.ctx = ctx
	}
}

class LegacyScopedService {
	static key = 'comparisonScoped' as const
	ctx: LegacyContext
	constructor(ctx: LegacyContext) {
		this.ctx = ctx
	}
}

class LegacyOwnerService {
	static key = 'comparisonOwner' as const
	ctx: LegacyContext
	constructor(ctx: LegacyContext) {
		this.ctx = ctx
	}
}

LegacyContext.registerService(asLegacyServiceClass(LegacyRootService))
LegacyContext.registerService(asLegacyServiceClass(LegacyScopedService))
LegacyContext.registerService(asLegacyServiceClass(LegacyOwnerService))

type LegacyProjection = {
	comparisonRoot: LegacyRootService
	comparisonScoped: LegacyScopedService
	comparisonOwner: LegacyOwnerService
}

const legacyRoot = new LegacyContext({ name: 'root' })
const legacyScope = legacyRoot.isolate([asLegacyServiceClass(LegacyScopedService)], {
	name: 'scope',
})
const legacyChild = legacyScope.extend({ name: 'child' })
const legacyRootProjection = legacyRoot as unknown as LegacyProjection
const legacyScopeProjection = legacyScope as unknown as LegacyProjection
const legacyChildProjection = legacyChild as unknown as LegacyProjection

const rootCapability = defineContextCapability<object>('comparison.root')
const scopeCapability = defineContextCapability<object>('comparison.scope')
const ownerCapability = defineContextCapability<{ readonly owner: Context }>('comparison.owner')
const currentHost = createContextHost({
	name: 'comparison',
	capabilities: [
		installRootCapability(rootCapability, {
			property: 'rootValue',
			create: () => ({}),
		}),
		installScopeCapability(scopeCapability, {
			property: 'scopeValue',
			create: () => ({}),
		}),
		installOwnerViewCapability(ownerCapability, {
			property: 'ownerValue',
			createRoot: () => ({}),
			createView: (_backing, owner) => ({ owner }),
		}),
	],
})
const currentRoot = currentHost.createRoot()
const currentScope = currentHost.createScope(currentRoot, 'scope')
const currentChild = currentHost.createChild(currentScope, 'child')

void legacyRootProjection.comparisonRoot
void legacyScopeProjection.comparisonScoped
void legacyRootProjection.comparisonOwner
void legacyChildProjection.comparisonOwner
void currentRoot.rootValue
void currentScope.scopeValue
void currentRoot.ownerValue
void currentChild.ownerValue

const getterBatch = 1_000
const creationBatch = 100
const bench = new Bench({ time: 750, warmupTime: 250 })
const legacyIsolatedServices = [asLegacyServiceClass(LegacyScopedService)] as const
let sink: unknown

bench.add('legacy cached root getter', () => {
	for (let index = 0; index < getterBatch; index += 1) {
		sink = legacyRootProjection.comparisonRoot
	}
})
bench.add('current cached root getter', () => {
	for (let index = 0; index < getterBatch; index += 1) sink = currentRoot.rootValue
})
bench.add('legacy cached isolated getter', () => {
	for (let index = 0; index < getterBatch; index += 1) {
		sink = legacyScopeProjection.comparisonScoped
	}
})
bench.add('current cached scope getter', () => {
	for (let index = 0; index < getterBatch; index += 1) sink = currentScope.scopeValue
})
bench.add('legacy alternating owner getter + mutable ctx rebind', () => {
	for (let index = 0; index < getterBatch; index += 1) {
		sink = legacyRootProjection.comparisonOwner
		sink = legacyChildProjection.comparisonOwner
	}
})
bench.add('current alternating stable owner-view getter', () => {
	for (let index = 0; index < getterBatch; index += 1) {
		sink = currentRoot.ownerValue
		sink = currentChild.ownerValue
	}
})
bench.add('legacy extend child creation', () => {
	for (let index = 0; index < creationBatch; index += 1) {
		sink = legacyScope.extend({ name: `child-${index}` })
	}
})
bench.add('current child creation', () => {
	for (let index = 0; index < creationBatch; index += 1) {
		sink = currentHost.createChild(currentScope, `child-${index}`)
	}
})
bench.add('legacy selective isolate creation', () => {
	for (let index = 0; index < creationBatch; index += 1) {
		sink = legacyRoot.isolate(legacyIsolatedServices, { name: `scope-${index}` })
	}
})
bench.add('current scope creation', () => {
	for (let index = 0; index < creationBatch; index += 1) {
		sink = currentHost.createScope(currentRoot, `scope-${index}`)
	}
})

await bench.run()

const operationBatch = (name: string): number => {
	if (name.includes('alternating')) return getterBatch * 2
	return name.includes('creation') ? creationBatch : getterBatch
}

console.table(
	bench.tasks.map((task) => {
		if (task.result.state !== 'completed') throw new Error(`Context benchmark failed: ${task.name}`)
		return {
			Path: task.name,
			'mean ns/op': ((task.result.latency.mean * 1_000_000) / operationBatch(task.name)).toFixed(2),
		}
	}),
)
console.log(
	'The owner pair compares the old shared-object ctx mutation with current stable per-owner views; it is an architectural comparison, not identical object semantics.',
)
console.log(
	'Creation rows compare the historical public operation with its current public host operation. Benchmarks are trend evidence and carry no release threshold.',
)
void sink
