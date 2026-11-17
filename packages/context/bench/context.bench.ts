import { Bench } from 'tinybench'
import {
	createChildContext,
	createContextPlan,
	createRootContext,
	createScopeContext,
	installOwnerViewService,
	installRootService,
	installScopeService,
	type ServiceInstallation,
} from '../src/kernel.ts'
import { resolveContextService } from '../src/internal.ts'
const batch = 1_000
const coldPlanBatch = 20
const bench = new Bench({ time: 750, warmupTime: 250 })
let sink: unknown
abstract class RootValue {}
abstract class ScopeValue {}
abstract class OwnerValue {
	abstract readonly owner: object
}
const installations = [
	installRootService(RootValue, { create: () => ({}) }),
	installScopeService(ScopeValue, { create: () => ({}) }),
	installOwnerViewService(OwnerValue, {
		createRoot: () => ({}),
		createView: (_root, owner) => ({ owner }),
	}),
]
const root = createRootContext(createContextPlan('hot', installations))
const scope = createScopeContext(root, 'scope')
const owner = createChildContext(scope, 'owner')
void root.service(RootValue)
void scope.service(ScopeValue)
void owner.service(OwnerValue)
bench.add('cached root service', () => {
	for (let index = 0; index < batch; index++) sink = root.service(RootValue)
})
bench.add('cached scope service', () => {
	for (let index = 0; index < batch; index++) sink = owner.service(ScopeValue)
})
bench.add('cached owner-view service', () => {
	for (let index = 0; index < batch; index++) sink = owner.service(OwnerValue)
})
bench.add('internal resolve root slot', () => {
	for (let index = 0; index < batch; index++) sink = resolveContextService(owner, RootValue)
})
bench.add('mixed root/scope/owner services', () => {
	for (let index = 0; index < batch; index++) {
		sink = root.service(RootValue)
		sink = owner.service(ScopeValue)
		sink = owner.service(OwnerValue)
	}
})
bench.add('owner-view first miss + child creation', () => {
	for (let index = 0; index < 100; index++)
		sink = createChildContext(scope, `cold-${index}`).service(OwnerValue)
})
bench.add('scope Context creation', () => {
	for (let index = 0; index < 100; index++) sink = createScopeContext(root, `scope-${index}`)
})
for (const size of [1, 8, 20]) {
	const source: ServiceInstallation[] = Array.from({ length: size }, () =>
		installRootService(class {}, { create: () => ({}) }),
	)
	const plan = createContextPlan(`size-${size}`, source)
	bench.add(`root Context creation (${size} services)`, () => {
		for (let index = 0; index < 100; index++) sink = createRootContext(plan)
	})
	bench.add(`host plan compilation + root creation (${size} services)`, () => {
		for (let index = 0; index < coldPlanBatch; index++)
			sink = createRootContext(createContextPlan('cold', source))
	})
}
await bench.run()
const operations = (name: string) =>
	name.includes('plan compilation')
		? coldPlanBatch
		: name.includes('mixed')
			? batch * 3
			: name.includes('first miss') || name.includes('creation')
				? 100
				: batch
console.table(
	bench.tasks.map((task) => {
		if (task.result.state !== 'completed') throw new Error(`Context benchmark failed: ${task.name}`)
		return {
			Path: task.name,
			'mean ns/op': ((task.result.latency.mean * 1_000_000) / operations(task.name)).toFixed(2),
			'median ns/op': ((task.result.latency.p50 * 1_000_000) / operations(task.name)).toFixed(2),
		}
	}),
)
console.log(
	'Service reads validate the receiver and access, map declaration identity to a compiled resolver and reuse scope-specific dense slots. Host plan compilation is reported separately.',
)
void sink
