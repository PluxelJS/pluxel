// tests/visibility.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'bun:test'
import { ContainerBuilder } from '../src'
import { expectErr, expectExist, expectOk } from './_helpers'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'

describe('only public services can be directly queried from the container', () => {
	it('public services are directly get-able; private only resolvable as deps', () => {
		// Arrange
		const builder = new ContainerBuilder()

		// Act
		expectOk(builder.tryRegisterAndUse(Agenda)).public()
		expectOk(builder.tryRegisterAndUse(Clock)).public()
		expectOk(builder.tryRegisterAndUse(Calendar)).private()

		const container = expectOk(builder.build())

		// Assert
		const agenda = expectExist(container.get(Agenda))
		expect(agenda.clock.constructor.name).toBe('Clock')
		expect(agenda.calendar.constructor.name).toBe('Calendar')

		const clock = expectExist(container.get(Clock))
		expect(clock.constructor.name).toBe('Clock')

		// 私有服务：get() 返回 Maybe（应为 undefined），getResult() 返回 Err(PrivateService)
		expect(container.get(Calendar)).toBeUndefined()

		const res = container.getResult(Calendar)
		const e = expectErr(
			res,
			'Calendar is private and cannot be directly resolved',
		)
		expect(e.kind).toBe('PrivateService')
		// 可选进一步校验 id：expect(e.id).toBe(Calendar)
	})
})
