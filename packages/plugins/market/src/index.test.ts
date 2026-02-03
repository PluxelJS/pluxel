import { describe, expect, test } from 'vitest'
import { checkPluginDecorator, getPluginInfo } from '@pluxel/core'
import { MarketUI } from './index'

describe('MarketUI', () => {
	test('exports a decorated plugin class', () => {
		expect(MarketUI).toBeDefined()
		expect(typeof MarketUI).toBe('function')
		expect(checkPluginDecorator(MarketUI)).toBe(true)
		expect(getPluginInfo(MarketUI).declaredName).toBe('MarketUI')
	})
})
