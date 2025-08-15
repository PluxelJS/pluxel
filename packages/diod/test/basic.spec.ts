// tests/basic.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { expectOk, expectExist, expectErr } from './_helpers'
import { ContainerBuilder } from '../src'
import { Clock } from './fixtures/clock'
import { ConsoleLogger } from './fixtures/console-logger'

describe('returns registered parameter-less constructor class instance', () => {
	it('resolves a class with no constructor parameters', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))
		const container = expectOk(builder.build())

		// Act
		const clock = expectExist(container.get(Clock))

		// Assert
		expect(clock.constructor.name).toBe('Clock')
		expect(clock.now()).not.toBe('')
	})
})

describe('throws error when asked for an unregistered service', () => {
	it('returns Err(NotRegistered) for unknown service via getResult', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))
		const container = expectOk(builder.build())

		// Act
		const res = container.getResult(ConsoleLogger)

		// Assert（结构化错误：NotRegistered）
		const e = expectErr(res, 'should be NotRegistered')
		expect(e.kind).toBe('NotRegistered')
	})
})
