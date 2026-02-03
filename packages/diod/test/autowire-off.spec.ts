// tests/autowire-off.ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ContainerBuilder } from '../src'
import { expectOk } from './_helpers'
import {
	BankUser,
	SessionManager,
	ShoppingCart,
	ShopUser,
} from './fixtures/user'

describe('the constructor of the extended class is injected if target has not constructor', () => {
	it('injects deps into subclass without an explicit constructor', () => {
		// Arrange
		const builder = new ContainerBuilder()

		expectOk(builder.tryRegisterAndUse(BankUser)).withDependencies([
			SessionManager,
		])
		expectOk(builder.tryRegisterAndUse(ShopUser)).withDependencies([
			SessionManager,
			ShoppingCart,
		])
		expectOk(builder.tryRegisterAndUse(SessionManager)).withDependencies([])
		expectOk(builder.tryRegisterAndUse(ShoppingCart))

		const container = expectOk(builder.build())

		// Act
		const bankUser = expectOk(container.getResult(BankUser))
		const shopUser = expectOk(container.getResult(ShopUser))

		// Assert
		expect(bankUser.constructor.name).toBe('BankUser')
		expect(shopUser.constructor.name).toBe('ShopUser')
		expect(() => bankUser.login()).not.toThrow()
		expect(() => shopUser.add()).not.toThrow()
	})
})
