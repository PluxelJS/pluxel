// tests/autoregistering.spec.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import { AutoRegisteredServiceSample } from './fixtures/autoregistered-services'
import { autoregister } from './fixtures/register-service-decorator'
import { expectOk, expectExist } from './_helpers'

describe('autoregisters classes with custom decorator', () => {
	it('registers and resolves the decorated class', () => {
		// Act
		const builder = new ContainerBuilder()
		autoregister(builder)
		const container = expectOk(builder.build())

		// Assert
		const service = expectExist(container.get(AutoRegisteredServiceSample))
		expect(service.constructor.name).toBe('AutoRegisteredServiceSample')
		expect(service.now()).not.toBe('')
	})
})
