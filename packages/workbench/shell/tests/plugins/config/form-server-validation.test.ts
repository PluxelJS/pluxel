import { describe, expect, it } from 'vitest'
import {
	mapConfigValidationErrors,
	mapServerValidationIssues,
} from '../../../src/app/forms/serverValidation'

describe('server validation routing', () => {
	it('binds array indices and preserves duplicate field messages', () => {
		expect(
			mapServerValidationIssues(
				[
					{ path: ['servers', 0, 'host'], message: 'Invalid host' },
					{ path: ['servers', 0, 'host'], message: 'Host unavailable' },
				],
				new Set(['servers[0].host']),
			),
		).toEqual({
			fields: {
				'servers[0].host': [{ message: 'Invalid host' }, { message: 'Host unavailable' }],
			},
		})
	})

	it('keeps inactive, hidden and ambiguous literal paths in the summary', () => {
		const paths = [
			['hidden'],
			['inactive', 'value'],
			['profile.host'],
			['servers', '0', 'host'],
			['profile', '', 'host'],
		]
		expect(
			mapServerValidationIssues(
				paths.map((path, index) => ({ path, message: `Issue ${index}` })),
				new Set(['profile.host', 'servers[0].host']),
			),
		).toEqual({
			fields: {},
			form: [
				'$.hidden · Issue 0',
				'$.inactive.value · Issue 1',
				'$["profile.host"] · Issue 2',
				'$.servers["0"].host · Issue 3',
				'$.profile[""].host · Issue 4',
			],
		})
	})

	it('assigns each config issue to its longest occurrence prefix, with one absolute fallback', () => {
		expect(
			mapConfigValidationErrors(
				{
					_root: {
						cache: [
							{ path: ['cache', 'servers', 0, 'host'], message: 'Invalid host' },
							{ path: ['cache', 'servers'], message: 'Duplicate connection IDs' },
							{ path: ['cache', 'servers', '0', 'host'], message: 'Literal key' },
							{ path: ['other', 'host'], message: 'Other section failed' },
							{ path: [], message: 'Configuration failed' },
						],
					},
				},
				[
					{ key: 'root', path: [], mounted: new Set(['cache.servers[0].host', 'other.host']) },
					{ key: 'cache', path: ['cache'], mounted: new Set(['servers[0].host', 'servers']) },
					{ key: 'other', path: ['other'] },
				],
			),
		).toEqual({
			fieldsBySection: new Map([
				[
					'cache',
					{
						'servers[0].host': [{ message: 'Invalid host' }],
						servers: [{ message: 'Duplicate connection IDs' }],
					},
				],
			]),
			summary: [
				'$.cache.servers["0"].host · Literal key',
				'$.other.host · Other section failed',
				'$ · Configuration failed',
			],
		})
	})
})
