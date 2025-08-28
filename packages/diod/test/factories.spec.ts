// tests/factories.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'bun:test'
import { ContainerBuilder } from '../src'
import { expectExist, expectOk } from './_helpers'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'

describe('returns instances created with factories', () => {
	it('resolves factory-produced instances', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Calendar))

		// Act: 注册工厂
		expectOk(builder.tryRegister(Clock)).useFactory(() => new Clock())
		expectOk(builder.tryRegister(Agenda)).useFactory(
			(c) =>
				new Agenda(expectExist(c.get(Clock)), expectExist(c.get(Calendar))),
		)

		const container = expectOk(builder.build())

		// Assert
		const agenda = expectExist(container.get(Agenda))
		expect(agenda.constructor.name).toBe('Agenda')
	})
})
