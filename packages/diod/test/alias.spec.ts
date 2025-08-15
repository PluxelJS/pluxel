// tests/alias.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { expectOk, expectErr, expectExist } from './_helpers'
import type { VerificationError } from '../src/verifier'
import { ServiceVerificationAggregateError } from '../src/verifier'

describe('alias index & resolution', () => {
	it('resolves by string alias', () => {
		class Foo {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Foo)).addAlias('foo')

		const container = expectOk(builder.build())
		const foo = expectExist(container.getByAlias<Foo>('foo'))
		expect(foo.constructor.name).toBe('Foo')
	})

	it('resolves by symbol alias', () => {
		class Bar {}
		const KEY = Symbol('bar')
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Bar)).addAlias(KEY)

		const container = expectOk(builder.build())
		const bar = expectExist(container.getByAlias<Bar>(KEY))
		expect(bar.constructor.name).toBe('Bar')
	})

	it('resolves by abstract-class alias', () => {
		abstract class ILogger {
			abstract log(msg: string): void
		}
		class Logger implements ILogger {
			log(): void {}
		}

		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Logger)).addAlias(
			ILogger as unknown as abstract new (
				...a: any[]
			) => any,
		)

		const container = expectOk(builder.build())
		const logger = expectExist(container.getByAlias<Logger>(ILogger as any))
		expect(logger.constructor.name).toBe('Logger')
	})

	it('getByAliasResult returns NotRegistered for unknown alias', () => {
		class Baz {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Baz)).addAlias('baz')

		const container = expectOk(builder.build())
		const r = container.getByAliasResult('nope')
		const e = expectErr(r, 'expected NotRegistered for unknown alias')
		expect(e.kind).toBe('NotRegistered')
		// id 应该就是传入的别名键
		expect((e as any).id).toBe('nope')
	})

	it('respects private visibility when resolving by alias', () => {
		class Secret {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Secret)).private().addAlias('secret')

		const container = expectOk(builder.build())
		const r = container.getByAliasResult('secret')
		const e = expectErr(r, 'private service should not be resolved via alias')
		expect(e.kind).toBe('PrivateService')
		// e.id 是实际的 Identifier，而不是 alias key
		// 可选：expect(e.id).toBe(Secret as any)
	})

	it('alias conflict -> error (default aliasPolicy=error)', () => {
		class A {}
		class B {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(A)).addAlias('dup')
		expectOk(builder.registerAndUse(B)).addAlias('dup')

		const err = expectErr(builder.build())
		expect(err).toBeInstanceOf(ServiceVerificationAggregateError)
		const hasAliasConflict = (
			err as ServiceVerificationAggregateError
		).errors.some(
			(x): x is Extract<VerificationError, { kind: 'AliasConflict' }> =>
				x.kind === 'AliasConflict',
		)
		expect(hasAliasConflict).toBeTrue()
		expect(err.format()).toContain('AliasConflict')
		expect(err.format()).toContain('dup')
	})

	it('alias conflict policy: lastWins', () => {
		class A {}
		class B {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(A)).addAlias('dup')
		expectOk(builder.registerAndUse(B)).addAlias('dup')

		const container = expectOk(builder.build({ aliasPolicy: 'lastWins' }))
		const resolved = expectExist(container.getByAlias<B>('dup'))
		expect(resolved.constructor.name).toBe('B')
	})

	it('alias conflict policy: firstWins', () => {
		class A {}
		class B {}
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(A)).addAlias('dup')
		expectOk(builder.registerAndUse(B)).addAlias('dup')

		const container = expectOk(builder.build({ aliasPolicy: 'firstWins' }))
		const resolved = expectExist(container.getByAlias<A>('dup'))
		expect(resolved.constructor.name).toBe('A')
	})

	it('multiple aliases map to the same service', () => {
		class Multi {}
		const ALPHA = Symbol('alpha')
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Multi))
			.addAlias('m1')
			.addAlias(ALPHA)
			.asSingleton()

		const container = expectOk(builder.build())
		const byStr = expectExist(container.getByAlias('m1'))
		const bySym = expectExist(container.getByAlias(ALPHA))
		expect(byStr).toBe(bySym)
	})
})
