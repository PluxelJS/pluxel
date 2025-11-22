import { describe, expect, it } from 'bun:test'
import { parsePackageName } from '../src/plop'

describe('plop name helpers', () => {
	it('prefixes bare package names with the first plugin prefix', () => {
		const result = parsePackageName('foo', ['pluxel-plugin'])
		expect(result.name).toBe('foo')
		expect(result.packageName).toBe('pluxel-plugin-foo')
	})

	it('keeps scoped names and applies prefix to the scoped segment', () => {
		const result = parsePackageName('@acme/foo', ['pluxel-plugin'])
		expect(result.name).toBe('foo')
		expect(result.packageName).toBe('@acme/pluxel-plugin-foo')
	})

	it('detects already prefixed names and avoids duplicates', () => {
		const result = parsePackageName('pluxel-plugin-bar', ['pluxel-plugin'])
		expect(result.name).toBe('pluxel-plugin-bar')
		expect(result.packageName).toBe('pluxel-plugin-bar')
	})

	it('respects any configured prefix when matching existing names', () => {
		const result = parsePackageName('acme-plugin-extra', ['pluxel-plugin', 'acme-plugin'])
		expect(result.packageName).toBe('acme-plugin-extra')
	})
})
