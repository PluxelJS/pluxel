import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ContainerBuilder } from '../src'
import { ServiceVerificationAggregateError } from '../src/verifier'
import { expectErr, expectExist, expectOk } from './_helpers'

describe('incremental build & cache invalidation', () => {
	it('keeps previously built containers immutable when configuration changes', () => {
		class Foo {}
		const builder = new ContainerBuilder()
		const reg = expectOk(builder.tryRegisterAndUse(Foo))

		const c1 = expectOk(builder.build())
		const meta1 = expectExist(c1.services.get(Foo))
		expect(meta1.tags).toEqual([])
		expect(meta1.aliases).toEqual([])
		expect(c1.findTaggedServiceIdentifiers('t').length).toBe(0)

		reg.addTag('t').addAlias('a')

		// Old container remains consistent with its own indices/snapshotted metadata.
		expect(meta1.tags).toEqual([])
		expect(meta1.aliases).toEqual([])
		expect(c1.findTaggedServiceIdentifiers('t').length).toBe(0)

		const c2 = expectOk(builder.build())
		expect(c2.findTaggedServiceIdentifiers('t')).toContain(Foo)
		expectExist(c2.getByAlias<Foo>('a'))
	})

	it('rebuilds when aliases are mutated after a successful build', () => {
		class Foo {}
		const builder = new ContainerBuilder()
		const reg = expectOk(builder.tryRegisterAndUse(Foo))

		const c1 = expectOk(builder.build())
		expect(c1.getByAlias('foo')).toBeUndefined()

		reg.addAlias('foo')

		const c2 = expectOk(builder.build())
		const foo = expectExist(c2.getByAlias<Foo>('foo'))
		expect(foo).toBeInstanceOf(Foo)
	})

	it('rebuilds when scope is mutated after a successful build', () => {
		class Foo {}
		const builder = new ContainerBuilder()
		const reg = expectOk(builder.tryRegisterAndUse(Foo))

		const c1 = expectOk(builder.build())
		const a1 = expectExist(c1.get(Foo))
		const a2 = expectExist(c1.get(Foo))
		expect(a1).not.toBe(a2) // default is transient

		reg.asSingleton()

		const c2 = expectOk(builder.build())
		const b1 = expectExist(c2.get(Foo))
		const b2 = expectExist(c2.get(Foo))
		expect(b1).toBe(b2)
	})

	it('catches missing dependencies after unregister (incremental path)', () => {
		class B {}
		class A {
			constructor(public b: B) {}
		}

		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(B))
		expectOk(builder.tryRegisterAndUse(A)).withDependencies([B])

		expectOk(builder.build({ autowire: false }))
		expectOk(builder.tryUnregister(B))

		const err = expectErr(builder.build({ autowire: false }))
		expect(err).toBeInstanceOf(ServiceVerificationAggregateError)
		expect(
			(err as ServiceVerificationAggregateError).errors.some((e) => e.kind === 'MissingDependency'),
		).toBe(true)
	})

	it('detects alias conflicts introduced after a successful build', () => {
		class A {}
		class B {}

		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(A)).addAlias('dup')
		expectOk(builder.build({ autowire: false, aliasPolicy: 'error' }))

		expectOk(builder.tryRegisterAndUse(B)).addAlias('dup')
		const err = expectErr(builder.build({ autowire: false, aliasPolicy: 'error' }))
		expect(err).toBeInstanceOf(ServiceVerificationAggregateError)
		expect(
			(err as ServiceVerificationAggregateError).errors.some((e) => e.kind === 'AliasConflict'),
		).toBe(true)
	})
})
