// tests/instances.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'
import { ConsoleLogger } from './fixtures/console-logger'
import { Person } from './fixtures/person'
import { Sayer } from './fixtures/sayer'
import { expectOk, expectExist } from './_helpers'

describe('returns manually created class instance', () => {
	it('resolves user-provided instances (useInstance)', () => {
		// Arrange: 先手动构造实例
		const clock = new Clock()
		const person = new Person(new ConsoleLogger())
		const builder = new ContainerBuilder()

		expectOk(builder.tryRegisterAndUse(Agenda))
		expectOk(builder.tryRegisterAndUse(Calendar))

		// Act: 注入实例
		expectOk(builder.tryRegister(Clock)).useInstance(clock)
		expectOk(builder.tryRegister(Sayer)).useInstance(person)

		const container = expectOk(builder.build())

		// Assert
		const sayer = expectExist(container.get(Sayer))
		const clk = expectExist(container.get(Clock))
		const agenda = expectExist(container.get(Agenda))

		expect(sayer.rand).toBe(person.rand)
		expect(clk.rand).toBe(clock.rand)
		expect(agenda.clock.rand).toBe(clock.rand)
	})
})
