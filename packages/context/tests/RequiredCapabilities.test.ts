import { expect, expectTypeOf, it } from 'vitest'
import {
	ContextCapabilityAccessError,
	ContextCapabilityMissingError,
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	type Context,
	type ContextCapabilityInstallation,
	type ContextOf,
} from '../src'

it('requires exact identities lazily and keeps owner views isolated', () => {
	let roots = 0
	let views = 0
	const capability = defineContextCapability<{ owner: Context }>('owner', {
		access: 'all',
		property: 'service',
	})
	const installation = installOwnerViewCapability(capability, {
		property: 'service',
		createRoot: () => ++roots,
		createView: (_, owner) => {
			views++
			return { owner }
		},
	})
	const host = createContextHost({ name: 'required', capabilities: [installation] })
	const root = host.createRoot()
	const plugin = host.createScope(root, 'plugin')
	const part = host.createChild(plugin, 'part')
	expect(roots).toBe(0)
	expect(plugin.require(capability)).toBe(plugin.service)
	expect(part.require(capability).owner).toBe(part)
	expect(part.require(capability)).not.toBe(plugin.require(capability))
	expect([roots, views]).toEqual([1, 2])
	const otherIdentity = defineContextCapability<{ owner: Context }>('owner')
	expect(() => plugin.require(otherIdentity)).toThrow(ContextCapabilityMissingError)
	expect(() => root.require({ ...capability })).toThrow(TypeError)
})

it('does not expose host authorities through require, including through ctx.root', () => {
	const authority = defineContextCapability<number>('authority', { access: 'root' })
	const legacyRoot = defineContextCapability<number>('legacy')
	const owner = defineContextCapability<number>('generation', { access: 'owner' })
	const host = createContextHost({
		name: 'access',
		capabilities: [
			installRootCapability(authority, { create: () => 1 }),
			installRootCapability(legacyRoot, { create: () => 2 }),
			installScopeCapability(owner, { property: 'generation', create: () => 3 }),
		],
	})
	const root = host.createRoot()
	const scope = host.createScope(root, 'plugin')
	expect(scope.require(owner)).toBe(3)
	expect(resolveContextCapability(root, authority)).toBe(1)
	expect(() => scope.root.require(authority as never)).toThrow(ContextCapabilityAccessError)
	expect(() => scope.require(legacyRoot)).toThrow(ContextCapabilityAccessError)
	expect(() => root.require(owner as never)).toThrow(ContextCapabilityAccessError)
	expect('generation' in root ? Reflect.get(root, 'generation') : undefined).toBeUndefined()
	const typeChecks = () => {
		// @ts-expect-error Root authorities cannot be required by authors, even through ctx.root.
		scope.root.require(authority)
		// @ts-expect-error Owner-only services do not belong to the root projection.
		root.generation
		// @ts-expect-error The root cannot require an owner-only token.
		root.require(owner)
	}
	void typeChecks
})

it('preserves construction errors and validates contracts before invoking factories', () => {
	const failure = new Error('backend unavailable')
	const capability = defineContextCapability<number>('broken', {
		access: 'all',
		property: 'broken',
	})
	const installation = installScopeCapability(capability, {
		property: 'broken',
		create: () => {
			throw failure
		},
	})
	const host = createContextHost({ name: 'failure', capabilities: [installation] })
	expect(() => host.createRoot().require(capability)).toThrow(failure)
	expect(() =>
		createContextHost({ name: 'conflict', capabilities: [installation, installation] }),
	).toThrow('more than once')
	expect(() =>
		createContextHost({
			name: 'property',
			capabilities: [installScopeCapability(capability, { property: 'other', create: () => 0 })],
		}),
	).toThrow('requires property broken')
	const reserved = defineContextCapability<number>('reserved')
	expect(() =>
		createContextHost({
			name: 'reserved',
			capabilities: [installScopeCapability(reserved, { property: 'require', create: () => 0 })],
		}),
	).toThrow('duplicate property require')
	const widened: readonly ContextCapabilityInstallation[] = [installation]
	const dynamic = createContextHost({ name: 'dynamic', capabilities: widened })
	expectTypeOf<ContextOf<typeof dynamic>>().toExtend<Context>()
	type DoesNotPromiseBroken = 'broken' extends keyof ContextOf<typeof dynamic> ? false : true
	expectTypeOf<DoesNotPromiseBroken>().toEqualTypeOf<true>()
})
