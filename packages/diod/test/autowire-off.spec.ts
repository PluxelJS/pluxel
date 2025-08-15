// tests/autowire-off.ts
import 'reflect-metadata'
import { describe, it, expect } from 'bun:test'
import { ContainerBuilder } from '../src'
import {
	BankUser,
	SessionManager,
	ShopUser,
	ShoppingCart,
} from './fixtures/user'
import { expectOk } from './_helpers'

describe('the constructor of the extended class is injected if target has not constructor', () => {
	it('injects deps into subclass without an explicit constructor', () => {
		// Arrange
		const builder = new ContainerBuilder()

		expectOk(builder.registerAndUse(BankUser)).withDependencies([
			SessionManager,
		])
		expectOk(builder.registerAndUse(ShopUser)).withDependencies([
			SessionManager,
			ShoppingCart,
		])
		expectOk(builder.registerAndUse(SessionManager)).withDependencies([])
		expectOk(builder.registerAndUse(ShoppingCart))

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
