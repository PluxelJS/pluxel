import { describe, expect, test } from 'bun:test'
import { MarketUI } from './index'

describe('MarketUI', () => {
	test('exports a plugin class', () => {
		expect(MarketUI).toBeDefined()
		expect(typeof MarketUI).toBe('function')
	})
})

