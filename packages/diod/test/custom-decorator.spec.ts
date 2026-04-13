// tests/custom-decorator.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ContainerBuilder } from '../src'
import { expectExist, expectOk } from './_helpers'
import { OtherServiceWithCustomDecorator } from './fixtures/other-service-with-custom-decorator'
import { ServiceWithCustomDecorator } from './fixtures/service-with-custom-decorator'
import { Truer } from './fixtures/truer'

describe('user defined decorators can be used', () => {
	it('registers via custom decorator and resolves dependency', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(ServiceWithCustomDecorator))
		expectOk(builder.tryRegister(Truer)).use(OtherServiceWithCustomDecorator)
		const container = expectOk(builder.build())

		// Act
		const service = expectExist(container.get(ServiceWithCustomDecorator))

		// Assert
		expect(service.constructor.name).toBe('ServiceWithCustomDecorator')
		expect(service.execDep()).toBe(true)
	})
})
