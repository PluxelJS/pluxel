import { describe, expect, it } from 'vitest'
import {
	createContextPlan,
	createCallerContextView,
	createGenerationContext,
	createOwnerContext,
	createRootContext,
	defineContextCapability,
	installGenerationCapability,
	installOwnerViewCapability,
	installRootCapability,
	prepareContextCapabilities,
	resolveContextCapability,
	type ContextCapabilityInstallation,
} from '../src/context/Context'
import { resolveCoreRootInputs } from '../src/context/core-plan'

describe('Context capability plan', () => {
	it('keeps root, generation and owner-view identity at their declared scope', () => {
		const rootCapability = defineContextCapability<object>('test.root')
		const generationCapability = defineContextCapability<object>('test.generation')
		const ownerCapability = defineContextCapability<{ owner: object }>('test.owner')
		const plan = createContextPlan('scope-test', [
			installRootCapability(rootCapability, {
				property: 'rootValue',
				create: () => ({}),
			}),
			installGenerationCapability(generationCapability, {
				property: 'generationValue',
				create: () => ({}),
			}),
			installOwnerViewCapability(ownerCapability, {
				property: 'ownerValue',
				createRoot: () => ({}),
				createView: (_root, owner) => ({ owner }),
			}),
		])
		const root = createRootContext(plan)
		const firstGeneration = createGenerationContext(root, 'first')
		const secondGeneration = createGenerationContext(root, 'second')
		const firstOwner = createOwnerContext(firstGeneration, 'first-owner')
		const secondOwner = createOwnerContext(firstGeneration, 'second-owner')

		expect(resolveContextCapability(firstOwner, rootCapability)).toBe(
			resolveContextCapability(secondGeneration, rootCapability),
		)
		expect(resolveContextCapability(firstOwner, generationCapability)).toBe(
			resolveContextCapability(secondOwner, generationCapability),
		)
		expect(resolveContextCapability(firstOwner, generationCapability)).not.toBe(
			resolveContextCapability(secondGeneration, generationCapability),
		)
		expect(resolveContextCapability(firstOwner, ownerCapability)).toBe(
			resolveContextCapability(firstOwner, ownerCapability),
		)
		expect(resolveContextCapability(firstOwner, ownerCapability)).not.toBe(
			resolveContextCapability(secondOwner, ownerCapability),
		)
		expect(resolveContextCapability(firstOwner, ownerCapability).owner).toBe(firstOwner)
	})

	it('isolates concurrent caller-edge owner views while sharing provider generation state', async () => {
		const generationCapability = defineContextCapability<object>('test.caller-generation')
		const ownerCapability = defineContextCapability<{ owner: object }>('test.caller-owner')
		let ownerViews = 0
		const plan = createContextPlan('caller-edges', [
			installGenerationCapability(generationCapability, { create: () => ({}) }),
			installOwnerViewCapability(ownerCapability, {
				createRoot: () => ({}),
				createView: (_root, owner) => {
					ownerViews += 1
					return { owner }
				},
			}),
		])
		const root = createRootContext(plan)
		const provider = createGenerationContext(root, 'provider')
		const firstConsumer = createGenerationContext(root, 'first-consumer')
		const secondConsumer = createGenerationContext(root, 'second-consumer')
		const firstEdge = createCallerContextView(provider, firstConsumer)
		const secondEdge = createCallerContextView(provider, secondConsumer)

		const [firstView, secondView] = await Promise.all([
			Promise.resolve().then(() => resolveContextCapability(firstEdge, ownerCapability)),
			Promise.resolve().then(() => resolveContextCapability(secondEdge, ownerCapability)),
		])
		expect(firstEdge.caller).toBe(firstConsumer)
		expect(secondEdge.caller).toBe(secondConsumer)
		expect(firstView.owner).toBe(firstEdge)
		expect(secondView.owner).toBe(secondEdge)
		expect(firstView).not.toBe(secondView)
		expect(resolveContextCapability(firstEdge, ownerCapability)).toBe(firstView)
		expect(resolveContextCapability(secondEdge, ownerCapability)).toBe(secondView)
		expect(resolveContextCapability(firstEdge, generationCapability)).toBe(
			resolveContextCapability(secondEdge, generationCapability),
		)
		expect(ownerViews).toBe(2)
	})

	it('allows independent hosts with different plans and the same projected property', () => {
		const firstCapability = defineContextCapability('test.first-plan')
		const secondCapability = defineContextCapability('test.second-plan')
		const first = createRootContext(
			createContextPlan('first-plan', [
				installRootCapability(firstCapability, {
					property: 'value',
					create: () => 'first',
				}),
			]),
		)
		const second = createRootContext(
			createContextPlan('second-plan', [
				installRootCapability(secondCapability, {
					property: 'value',
					create: () => 'second',
				}),
			]),
		)

		expect((first as unknown as { value: string }).value).toBe('first')
		expect((second as unknown as { value: string }).value).toBe('second')
		expect(() => resolveContextCapability(first, secondCapability)).toThrow('does not install')
	})

	it('fully isolates values and prepare tasks for two roots using the same plan', async () => {
		const rootCapability = defineContextCapability<object>('test.same-plan-root')
		const generationCapability = defineContextCapability<object>('test.same-plan-generation')
		let prepareCalls = 0
		const plan = createContextPlan('same-plan-hosts', [
			installRootCapability(rootCapability, {
				property: 'rootValue',
				create: () => ({}),
				prepare: () => {
					prepareCalls += 1
				},
			}),
			installGenerationCapability(generationCapability, {
				property: 'generationValue',
				create: () => ({}),
			}),
		])
		const firstRoot = createRootContext(plan)
		const secondRoot = createRootContext(plan)
		const firstGeneration = createGenerationContext(firstRoot, 'first')
		const secondGeneration = createGenerationContext(secondRoot, 'second')

		expect(resolveContextCapability(firstRoot, rootCapability)).not.toBe(
			resolveContextCapability(secondRoot, rootCapability),
		)
		expect(resolveContextCapability(firstGeneration, generationCapability)).not.toBe(
			resolveContextCapability(secondGeneration, generationCapability),
		)
		expect(Object.getPrototypeOf(firstRoot)).toBe(Object.getPrototypeOf(secondRoot))
		await Promise.all([
			prepareContextCapabilities(firstRoot),
			prepareContextCapabilities(secondRoot),
		])
		await Promise.all([
			prepareContextCapabilities(firstRoot),
			prepareContextCapabilities(secondRoot),
		])
		expect(prepareCalls).toBe(2)
	})

	it('uses one slot for projected getters and isolates provider and caller-edge owner views', () => {
		const capability = defineContextCapability<{ owner: object }>('test.projected-owner')
		let rootFactories = 0
		let viewFactories = 0
		const plan = createContextPlan('projected-owner', [
			installOwnerViewCapability(capability, {
				property: 'ownerValue',
				createRoot: () => {
					rootFactories += 1
					return {}
				},
				createView: (_root, owner) => {
					viewFactories += 1
					return { owner }
				},
			}),
		])
		const root = createRootContext(plan)
		const provider = createGenerationContext(root, 'provider')
		const consumerA = createGenerationContext(root, 'consumer-a')
		const consumerB = createGenerationContext(root, 'consumer-b')
		const edgeA = createCallerContextView(provider, consumerA)
		const edgeB = createCallerContextView(provider, consumerB)
		const projected = (ctx: object) =>
			(ctx as { readonly ownerValue: { owner: object } }).ownerValue

		const providerValue = projected(provider)
		const edgeAValue = projected(edgeA)
		const edgeBValue = projected(edgeB)
		expect(providerValue).toBe(resolveContextCapability(provider, capability))
		expect(edgeAValue).toBe(resolveContextCapability(edgeA, capability))
		expect(edgeBValue).toBe(resolveContextCapability(edgeB, capability))
		expect(providerValue.owner).toBe(provider)
		expect(edgeAValue.owner).toBe(edgeA)
		expect(edgeBValue.owner).toBe(edgeB)
		expect(new Set([providerValue, edgeAValue, edgeBValue])).toHaveLength(3)
		expect(rootFactories).toBe(1)
		expect(viewFactories).toBe(3)
	})

	it('rejects duplicate descriptors, properties, construction cycles and undefined factories', () => {
		const duplicate = defineContextCapability('test.duplicate')
		const install = installRootCapability(duplicate, { create: () => ({}) })
		expect(() => createContextPlan('duplicate-capability', [install, install])).toThrow(
			'more than once',
		)

		const other = defineContextCapability('test.other')
		expect(() =>
			createContextPlan('duplicate-property', [
				installRootCapability(duplicate, { property: 'value', create: () => ({}) }),
				installRootCapability(other, { property: 'value', create: () => ({}) }),
			]),
		).toThrow('duplicate property')
		expect(() =>
			createContextPlan('prototype-property', [
				installRootCapability(other, { property: 'root', create: () => ({}) }),
			]),
		).toThrow('duplicate property root')

		const cycleA = defineContextCapability('test.cycle-a')
		const cycleB = defineContextCapability('test.cycle-b')
		const cyclePlan = createContextPlan('cycle', [
			installRootCapability(cycleA, {
				create: (ctx) => resolveContextCapability(ctx, cycleB),
			}),
			installRootCapability(cycleB, {
				create: (ctx) => resolveContextCapability(ctx, cycleA),
			}),
		])
		expect(() => resolveContextCapability(createRootContext(cyclePlan), cycleA)).toThrow(
			'construction cycle',
		)

		const missing = defineContextCapability<never>('test.undefined')
		const missingPlan = createContextPlan('undefined', [
			installRootCapability(missing, { create: () => undefined as never }),
		])
		expect(() => resolveContextCapability(createRootContext(missingPlan), missing)).toThrow(
			'returned undefined',
		)
	})

	it('freezes plan structure and plan-local prototype', () => {
		const capability = defineContextCapability('test.frozen')
		const plan = createContextPlan('frozen', [
			installRootCapability(capability, { property: 'value', create: () => 1 }),
		])
		const root = createRootContext(plan)

		expect(Object.isFrozen(plan)).toBe(true)
		expect(Object.isFrozen(plan.installations)).toBe(true)
		expect(Object.isFrozen(plan.resolvers)).toBe(true)
		expect(Object.isFrozen(plan.prototype)).toBe(true)
		expect(Object.getPrototypeOf(root)).toBe(plan.prototype)
		expect('config' in root).toBe(false)
		expect(() => Object.defineProperty(plan.prototype, 'late', { value: true })).toThrow(/Cannot/)
	})

	it('copies and freezes Core root inputs before lazy capability construction', () => {
		const logger = { rootId: 'first' }
		const plugins = { startConcurrency: 2 }
		const inputs = resolveCoreRootInputs({ name: 'host', logger, plugins })
		logger.rootId = 'mutated'
		plugins.startConcurrency = 99

		expect(inputs).toEqual({
			name: 'host',
			logger: { rootId: 'first' },
			plugins: { startConcurrency: 2 },
		})
		expect(Object.isFrozen(inputs)).toBe(true)
		expect(Object.isFrozen(inputs.logger)).toBe(true)
		expect(Object.isFrozen(inputs.plugins)).toBe(true)
	})

	it('shares one concurrent prepare and permits a later retry after failure', async () => {
		const capability = defineContextCapability<object>('test.prepare')
		let calls = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		const plan = createContextPlan('prepare', [
			installRootCapability(capability, {
				create: () => ({}),
				prepare: async () => {
					calls += 1
					await gate
				},
			}),
		])
		const root = createRootContext(plan)
		const first = prepareContextCapabilities(root)
		const second = prepareContextCapabilities(root)
		await Promise.resolve()
		expect(calls).toBe(1)
		release()
		await Promise.all([first, second])
		expect(calls).toBe(1)

		let attempts = 0
		const retryCapability = defineContextCapability<object>('test.prepare-retry')
		const retryPlan = createContextPlan('prepare-retry', [
			installRootCapability(retryCapability, {
				create: () => ({}),
				prepare: () => {
					attempts += 1
					if (attempts === 1) throw new Error('not ready')
				},
			}),
		])
		const retryRoot = createRootContext(retryPlan)
		await expect(prepareContextCapabilities(retryRoot)).rejects.toThrow('not ready')
		await expect(prepareContextCapabilities(retryRoot)).resolves.toBeUndefined()
		expect(attempts).toBe(2)
	})

	it('prepares an owner-view root backing without constructing a root owner view', async () => {
		const capability = defineContextCapability<{ kind: 'view' }>('test.prepare-owner-view')
		const backing = { kind: 'backing' as const }
		let viewCalls = 0
		let prepared: unknown
		const plan = createContextPlan('prepare-owner-view', [
			installOwnerViewCapability(capability, {
				property: 'ownerValue',
				createRoot: () => backing,
				createView: () => {
					viewCalls += 1
					return { kind: 'view' }
				},
				prepare: (rootBacking) => {
					prepared = rootBacking
				},
			}),
		])
		const root = createRootContext(plan)

		await prepareContextCapabilities(root)
		expect(prepared).toBe(backing)
		expect(viewCalls).toBe(0)
		expect((root as unknown as { ownerValue: unknown }).ownerValue).not.toBe(backing)
		expect(viewCalls).toBe(1)
	})

	it('eagerly constructs root backing without requiring an empty prepare hook', async () => {
		const rootCapability = defineContextCapability<object>('test.eager-root')
		const ownerCapability = defineContextCapability<object>('test.eager-owner')
		let rootCreations = 0
		let ownerRootCreations = 0
		let ownerViewCreations = 0
		const plan = createContextPlan('eager-construction', [
			installRootCapability(rootCapability, {
				eager: true,
				create: () => {
					rootCreations += 1
					return {}
				},
			}),
			installOwnerViewCapability(ownerCapability, {
				eager: true,
				createRoot: () => {
					ownerRootCreations += 1
					return {}
				},
				createView: () => {
					ownerViewCreations += 1
					return {}
				},
			}),
		])
		const root = createRootContext(plan)

		expect(rootCreations).toBe(0)
		expect(ownerRootCreations).toBe(0)
		await prepareContextCapabilities(root)
		await prepareContextCapabilities(root)
		expect(rootCreations).toBe(1)
		expect(ownerRootCreations).toBe(1)
		expect(ownerViewCreations).toBe(0)
	})

	it('allows a failed capability factory to retry without retaining construction state', () => {
		let attempts = 0
		const capability = defineContextCapability('test.factory-retry')
		const plan = createContextPlan('factory-retry', [
			installRootCapability(capability, {
				create: () => {
					attempts += 1
					if (attempts === 1) throw new Error('first failure')
					return 'ready'
				},
			}),
		])
		const root = createRootContext(plan)
		expect(() => resolveContextCapability(root, capability)).toThrow('first failure')
		expect(resolveContextCapability(root, capability)).toBe('ready')
		expect(attempts).toBe(2)
	})

	it('allows a failed owner-view factory to retry without poisoning its root backing', () => {
		let rootAttempts = 0
		let viewAttempts = 0
		const capability = defineContextCapability('test.owner-view-retry')
		const plan = createContextPlan('owner-view-retry', [
			installOwnerViewCapability(capability, {
				createRoot: () => {
					rootAttempts += 1
					return {}
				},
				createView: () => {
					viewAttempts += 1
					if (viewAttempts === 1) throw new Error('first view failure')
					return 'ready'
				},
			}),
		])
		const owner = createGenerationContext(createRootContext(plan), 'owner')

		expect(() => resolveContextCapability(owner, capability)).toThrow('first view failure')
		expect(resolveContextCapability(owner, capability)).toBe('ready')
		expect(rootAttempts).toBe(1)
		expect(viewAttempts).toBe(2)
	})

	it('accepts a frozen installation list without mutating caller input', () => {
		const capability = defineContextCapability('test.input')
		const installations = Object.freeze([
			installRootCapability(capability, { create: () => 'ok' }),
		]) satisfies readonly ContextCapabilityInstallation[]
		createContextPlan('input', installations)
		expect(Object.isFrozen(installations)).toBe(true)
	})
})
