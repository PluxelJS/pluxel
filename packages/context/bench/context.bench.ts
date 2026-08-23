import { Bench } from 'tinybench'
import {
	createChildContext,
	createContextPlan,
	createRootContext,
	createScopeContext,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	type ContextCapabilityInstallation,
} from '../src/kernel.ts'

const batch = 1_000
const coldPlanBatch = 20
const bench = new Bench({ time: 750, warmupTime: 250 })
let sink: unknown

const rootCapability = defineContextCapability<object>('bench.root')
const scopeCapability = defineContextCapability<object>('bench.scope')
const ownerCapability = defineContextCapability<object>('bench.owner')
const hotPlan = createContextPlan('context-hot', [
	installRootCapability(rootCapability, { property: 'rootValue', create: () => ({}) }),
	installScopeCapability(scopeCapability, { property: 'scopeValue', create: () => ({}) }),
	installOwnerViewCapability(ownerCapability, {
		property: 'ownerValue',
		createRoot: () => ({}),
		createView: (_root, owner) => ({ owner }),
	}),
])
const root = createRootContext(hotPlan)
const scope = createScopeContext(root, 'scope')
const owner = createChildContext(scope, 'owner')
type RootProjection = { rootValue: object }
type ContextProjection = { scopeValue: object; ownerValue: object }
const hotRoot = root as unknown as RootProjection
const hot = owner as unknown as ContextProjection
void hotRoot.rootValue
void hot.scopeValue
void hot.ownerValue

const nullRecord = Object.create(null) as Record<string, object>
nullRecord.value = {}
const descriptorKey = defineContextCapability<object>('bench.descriptor-key')
const descriptorMap = new Map([[descriptorKey, {}]])

bench.add('cached root getter', () => {
	for (let index = 0; index < batch; index += 1) sink = hotRoot.rootValue
})
bench.add('cached scope getter', () => {
	for (let index = 0; index < batch; index += 1) sink = hot.scopeValue
})
bench.add('cached owner-view getter', () => {
	for (let index = 0; index < batch; index += 1) sink = hot.ownerValue
})
bench.add('explicit resolve (descriptor identity + cached root slot)', () => {
	for (let index = 0; index < batch; index += 1) {
		sink = resolveContextCapability(owner, rootCapability)
	}
})
bench.add('null-prototype string lookup baseline (not descriptor-safe)', () => {
	for (let index = 0; index < batch; index += 1) sink = nullRecord.value
})
bench.add('Map capability-identity lookup baseline', () => {
	for (let index = 0; index < batch; index += 1) sink = descriptorMap.get(descriptorKey)
})
bench.add('owner-view first miss + child creation', () => {
	for (let index = 0; index < 100; index += 1) {
		const cold = createChildContext(scope, `cold-${index}`) as unknown as ContextProjection
		sink = cold.ownerValue
	}
})
bench.add('scope Context creation', () => {
	for (let index = 0; index < 100; index += 1) {
		sink = createScopeContext(root, `scope-${index}`)
	}
})

for (const size of [1, 8, 20] as const) {
	const installations: ContextCapabilityInstallation[] = []
	for (let index = 0; index < size; index += 1) {
		installations.push(
			installRootCapability(defineContextCapability(`bench.create.${size}.${index}`), {
				property: `capability${index}`,
				create: () => index,
			}),
		)
	}
	const plan = createContextPlan(`context-create-${size}`, installations)
	bench.add(`root Context creation (${size} capabilities)`, () => {
		for (let index = 0; index < 100; index += 1) sink = createRootContext(plan)
	})
	bench.add(`host plan compilation + root creation (${size} capabilities)`, () => {
		for (let index = 0; index < coldPlanBatch; index += 1) {
			sink = createRootContext(createContextPlan(`context-cold-${size}`, installations))
		}
	})
}

await bench.run()

const operationBatch = (name: string): number => {
	if (name.includes('plan compilation')) return coldPlanBatch
	return name.includes('first miss') || name.includes('creation') ? 100 : batch
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
	'Cached ctx.foo uses one scope-specialized resolver and a direct dense-array slot read. Explicit resolve uses Map only to compile a capability object identity into that numeric slot; the null-prototype string baseline is not a semantic substitute.',
)
console.log('Host compilation is a cold root-construction cost and is reported separately.')
void sink
