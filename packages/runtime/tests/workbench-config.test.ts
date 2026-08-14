import { describe, expect, it } from 'vitest'
import {
	matchesWorkbenchUiBasePath,
	normalizeWorkbenchUiBasePath,
	resolveWorkbenchUiBasePath,
} from '../src/workbench-config'

describe('Workbench UI base path', () => {
	it('keeps the compatible root default and removes trailing slashes', () => {
		expect(resolveWorkbenchUiBasePath(undefined)).toBe('/')
		expect(resolveWorkbenchUiBasePath(false)).toBe('/')
		expect(normalizeWorkbenchUiBasePath('/__pluxel/workbench///')).toBe('/__pluxel/workbench')
	})

	it.each([
		'',
		'relative',
		'//authority',
		'/%2fauthority',
		'/with\\backslash',
		'/with%5cbackslash',
		'/with\0nul',
		'/with%00nul',
		'/with?query',
		'/with#hash',
		'/./segment',
		'/../segment',
		'/%2e/segment',
		'/%2e%2e/segment',
		'/%invalid',
	])('rejects an unsafe or ambiguous path: %s', (value) => {
		expect(() => normalizeWorkbenchUiBasePath(value)).toThrow(TypeError)
	})

	it('matches only the configured path boundary', () => {
		expect(matchesWorkbenchUiBasePath('/__pluxel/workbench', '/__pluxel/workbench')).toBe(true)
		expect(matchesWorkbenchUiBasePath('/__pluxel/workbench/logs', '/__pluxel/workbench')).toBe(true)
		expect(matchesWorkbenchUiBasePath('/__pluxel/workbench-extra', '/__pluxel/workbench')).toBe(
			false,
		)
		expect(matchesWorkbenchUiBasePath('/anything', '/')).toBe(true)
	})
})
