// tests/scope.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ContainerBuilder } from '../src'
import { expectExist, expectOk } from './_helpers'
import { Agenda } from './fixtures/agenda'
import { Calendar } from './fixtures/calendar'
import { Clock } from './fixtures/clock'
import { MultiAgenda } from './fixtures/multi-agenda'

describe('scopes', () => {
	it('transient services are always created as new instances', () => {
		// Arrange
		const builder = new ContainerBuilder()

		// Act
		expectOk(builder.tryRegisterAndUse(Calendar)).asTransient()
		expectOk(builder.tryRegister(Clock))
			.useFactory(() => new Clock())
			.asTransient()
		expectOk(builder.tryRegister(Agenda))
			.useFactory((c) => new Agenda(expectExist(c.get(Clock)), expectExist(c.get(Calendar))))
			.asTransient()
		expectOk(builder.tryRegisterAndUse(MultiAgenda)).asTransient()

		const container = expectOk(builder.build())

		// Assert
		const calendar = expectExist(container.get(Calendar))
		const agenda = expectExist(container.get(Agenda))
		const clock = expectExist(container.get(Clock))
		const agenda2 = expectExist(container.get(Agenda))
		const multiAgenda = expectExist(container.get(MultiAgenda))

		expect(calendar.rand).not.toBe(agenda.calendar.rand)
		expect(clock.rand).not.toBe(agenda.clock.rand)
		expect(agenda.rand).not.toBe(agenda2.rand)
		expect(multiAgenda.agenda1.rand).not.toBe(multiAgenda.agenda2.rand)
		expect(multiAgenda.agenda1.clock.rand).not.toBe(multiAgenda.agenda2.clock.rand)
		expect(multiAgenda.agenda1.clock.rand).not.toBe(clock.rand)
	})

	it('singleton services are always the same instance within a container', () => {
		// Arrange
		const builder = new ContainerBuilder()

		// Act
		expectOk(builder.tryRegisterAndUse(Calendar)).asSingleton()
		expectOk(builder.tryRegister(Clock))
			.useFactory(() => new Clock())
			.asSingleton()
		expectOk(builder.tryRegister(Agenda))
			.useFactory((c) => new Agenda(expectExist(c.get(Clock)), expectExist(c.get(Calendar))))
			.asSingleton()
		expectOk(builder.tryRegisterAndUse(MultiAgenda)).asSingleton()

		const container = expectOk(builder.build())

		// Assert
		const calendar = expectExist(container.get(Calendar))
		const agenda = expectExist(container.get(Agenda))
		const clock = expectExist(container.get(Clock))
		const agenda2 = expectExist(container.get(Agenda))
		const multiAgenda = expectExist(container.get(MultiAgenda))

		expect(calendar.rand).toBe(agenda.calendar.rand)
		expect(clock.rand).toBe(agenda.clock.rand)
		expect(agenda.rand).toBe(agenda2.rand)
		expect(multiAgenda.agenda1.rand).toBe(multiAgenda.agenda2.rand)
		expect(multiAgenda.agenda1.clock.rand).toBe(multiAgenda.agenda2.clock.rand)
		expect(multiAgenda.agenda1.clock.rand).toBe(clock.rand)
		expect(multiAgenda.agenda2.clock.rand).toBe(clock.rand)
	})

	it('per-request services are the same within one root resolution, but not across roots', () => {
		// Arrange
		const builder = new ContainerBuilder()

		// Act
		expectOk(builder.tryRegisterAndUse(Calendar)).asSingleton()
		expectOk(builder.tryRegister(Clock))
			.useFactory(() => new Clock())
			.asInstancePerRequest()
		expectOk(builder.tryRegister(Agenda))
			.useFactory((c) => new Agenda(expectExist(c.get(Clock)), expectExist(c.get(Calendar))))
			.asInstancePerRequest()
		expectOk(builder.tryRegisterAndUse(MultiAgenda)).asInstancePerRequest()

		const container = expectOk(builder.build())

		// Assert (root resolutions: each get* call starts a fresh per-request scope)
		const calendar = expectExist(container.get(Calendar))
		const agenda1 = expectExist(container.get(Agenda))
		const clock1 = expectExist(container.get(Clock))
		const agenda2 = expectExist(container.get(Agenda))
		const multiAgenda = expectExist(container.get(MultiAgenda))

		// Calendar is singleton, reused everywhere
		expect(calendar.rand).toBe(agenda1.calendar.rand)
		expect(calendar.rand).toBe(agenda2.calendar.rand)

		// Different root resolutions -> different per-request instances
		expect(clock1.rand).not.toBe(agenda1.clock.rand)
		expect(agenda1.rand).not.toBe(agenda2.rand)

		// Inside MultiAgenda, both agendas resolve in one dependency chain -> same per-request instances
		expect(multiAgenda.agenda1.rand).toBe(multiAgenda.agenda2.rand)
		expect(multiAgenda.agenda1.clock.rand).toBe(multiAgenda.agenda2.clock.rand)

		// Different roots vs internal chain
		expect(multiAgenda.agenda1.clock.rand).not.toBe(clock1.rand)
		expect(multiAgenda.agenda2.clock.rand).not.toBe(clock1.rand)
	})

	// —— Builder Singleton: the distinguishing behavior is "shared across containers built from the SAME builder" ——

	it('builder-singleton shares the same instance across containers built from the same builder', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Calendar)).asBuilderSingleton()

		const c1 = expectOk(builder.build())
		const a1 = expectExist(c1.get(Calendar))

		const c2 = expectOk(builder.build())
		const a2 = expectExist(c2.get(Calendar))

		// Key difference from normal singleton: same instance across containers (same builder)
		expect(a1).toBe(a2)
		expect(a1.rand).toBe(a2.rand)

		// Lazy creation confirmed: only after first get, the builder cache contains the instance
		expect(builder.builderSingletons.has(Calendar)).toBe(true)
	})

	it('builder-singleton does NOT share across different builders', () => {
		const b1 = new ContainerBuilder()
		expectOk(b1.tryRegisterAndUse(Calendar)).asBuilderSingleton()
		const a1 = expectExist(expectOk(b1.build()).get(Calendar))

		const b2 = new ContainerBuilder()
		expectOk(b2.tryRegisterAndUse(Calendar)).asBuilderSingleton()
		const a2 = expectExist(expectOk(b2.build()).get(Calendar))

		expect(a1).not.toBe(a2)
	})

	it('normal singleton differs across containers (contrast with builder-singleton)', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock)).asSingleton()

		const c1 = expectOk(builder.build())
		const s1 = expectExist(c1.get(Clock))

		const c2 = expectOk(builder.build())
		const s2 = expectExist(c2.get(Clock))

		// Normal Singleton is per-container, so instances differ across builds
		expect(s1).not.toBe(s2)
	})

	it('unregister clears builder-singleton instance so a new one is created next time', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Calendar)).asBuilderSingleton()

		const first = expectExist(expectOk(builder.build()).get(Calendar))

		// Unregister removes both registration and builder-singleton cached instance
		expectOk(builder.tryUnregister(Calendar))

		// Re-register the same service; a new instance should be created
		expectOk(builder.tryRegisterAndUse(Calendar)).asBuilderSingleton()
		const second = expectExist(expectOk(builder.build()).get(Calendar))

		expect(second).not.toBe(first)
	})
})
