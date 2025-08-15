// tests/abstractions.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { ConsoleLogger } from './fixtures/console-logger'
import { Conversation } from './fixtures/conversation'
import { Logger } from './fixtures/logger'
import { Person } from './fixtures/person'
import { Sayer } from './fixtures/sayer'
import { expectOk, expectExist } from './_helpers'

describe('the constructor of the extended class is injected if target has not constructor', () => {
	it('injects deps and resolves concrete instance', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.registerAndUse(Person))
		expectOk(builder.register(Logger)).use(ConsoleLogger)
		const container = expectOk(builder.build())

		// Act
		const person = expectExist(container.get(Person))

		// Assert
		expect(person.constructor.name).toBe('Person')
		expect(() => person.say()).not.toThrow()
	})
})

describe('abstractions can be used as identifiers but concrete class instances are recovered', () => {
	it('resolves Person via Sayer identifier', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.register(Sayer)).use(Person)
		expectOk(builder.register(Logger)).use(ConsoleLogger)
		expectOk(builder.registerAndUse(Conversation))
		const container = expectOk(builder.build())

		// Act
		const sayer = expectExist(container.get(Sayer))

		// Assert
		expect(sayer.constructor.name).toBe('Person')
		expect(() => sayer.say()).not.toThrow()
	})
})
