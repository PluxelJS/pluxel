// tests/factories.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'
import { expectOk, expectExist } from './_helpers'

describe('returns instances created with factories', () => {
	it('resolves factory-produced instances', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Calendar))

		// Act: 注册工厂
		expectOk(builder.register(Clock)).useFactory(() => new Clock())
		expectOk(builder.register(Agenda)).useFactory(
			(c) =>
				new Agenda(expectExist(c.get(Clock)), expectExist(c.get(Calendar))),
		)

		const container = expectOk(builder.build())

		// Assert
		const agenda = expectExist(container.get(Agenda))
		expect(agenda.constructor.name).toBe('Agenda')
	})
})
