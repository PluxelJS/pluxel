// tests/tagging.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ContainerBuilder, type Identifier } from '../src'
import { expectExist, expectOk } from './_helpers'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'
import { ConsoleLogger } from './fixtures/console-logger'
import { OtherSayer } from './fixtures/hello-sayer'
import { Logger } from './fixtures/logger'
import { MultiAgenda } from './fixtures/multi-agenda'
import { Person } from './fixtures/person'
import { Sayer } from './fixtures/sayer'

describe('service identifiers can be get based on tag', () => {
	it('findTaggedServiceIdentifiers works in factory context and container', () => {
		// Arrange
		const builder = new ContainerBuilder()

		// Act (registrations + tags)
		expectOk(builder.tryRegisterAndUse(Calendar)).addTag('tag1').addTag('calendar')

		expectOk(builder.tryRegister(Clock))
			.useFactory(() => new Clock())
			.addTag('tag1')
			.addTag('tag2')
			.addTag('clock')

		expectOk(builder.tryRegister(Sayer))
			.useInstance(new Person(new ConsoleLogger()))
			.addTag('tag2')
			.addTag('sayer')

		expectOk(builder.tryRegister(Logger)).use(ConsoleLogger).addTag('logger')
		expectOk(builder.tryRegisterAndUse(OtherSayer)).addTag('sayer')

		expectOk(builder.tryRegister(Agenda))
			.useFactory((c) => {
				// 在 FactoryContext 中用 tag 反查 identifiers，然后用 getResult/get 取实例
				const clockIds = c.findTaggedServiceIdentifiers<Clock>('clock')
				const calendarIds = c.findTaggedServiceIdentifiers<Calendar>('calendar')

				const clock = expectExist(c.get(clockIds[0] as Identifier<Clock>), 'clock should exist')
				const calendar = expectExist(
					c.get(calendarIds[0] as Identifier<Calendar>),
					'calendar should exist',
				)
				return new Agenda(clock, calendar)
			})
			.addTag('tag1')

		expectOk(builder.tryRegisterAndUse(MultiAgenda)).addTag('tag3')

		const container = expectOk(builder.build())

		// Assert
		const serviceIdentifiersTaggedWithTag1 = container.findTaggedServiceIdentifiers('tag1')
		const sayerIdentifiers = container.findTaggedServiceIdentifiers<Sayer>('sayer')

		const sayers = sayerIdentifiers.map((id) => expectExist(container.get(id)))
		const agenda = expectExist(container.get(Agenda))

		expect(serviceIdentifiersTaggedWithTag1.length).toBe(3)
		expect(sayers.length).toBe(2)
		const [s0, s1] = sayers
		expect(s0.rand).not.toBeUndefined()
		expect(s1.rand).not.toBeUndefined()
		expect(agenda.now()).not.toBe('')
	})
})
