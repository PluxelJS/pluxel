// tests/basic-with-dependencies.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'
import { expectOk, expectExist } from './_helpers'

describe('returns registered instance with basic dependencies', () => {
	it('resolves Agenda with its basic deps', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegister(Clock)).use(Clock)
		expectOk(builder.tryRegisterAndUse(Calendar))
		expectOk(builder.tryRegister(Agenda)).useClass(Agenda)
		const container = expectOk(builder.build())

		// Act
		const agenda = expectExist(container.get(Agenda))

		// Assert
		expect(agenda.constructor.name).toBe('Agenda')
		expect(agenda.now()).not.toBe('')
	})
})
