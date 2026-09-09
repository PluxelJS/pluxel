import { describe, expect, it } from 'vitest'
import {
	mapConfigValidationErrors,
	mapServerValidationIssues,
} from '../src/app/forms/serverValidation'

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
		).toEqual({ fields: {}, form: paths.map((_, index) => `Issue ${index}`) })
	})

	it('relativizes config section errors and restores stringified array indices', () => {
		expect(
			mapConfigValidationErrors(
				{
					_root: {
						cache: [
							{ path: ['cache', 'servers', '0', 'host'], message: 'Invalid host' },
							{ path: ['other', 'host'], message: 'Other section failed' },
						],
					},
				},
				new Set(['servers[0].host']),
				['cache'],
			),
		).toEqual({
			fields: { 'servers[0].host': [{ message: 'Invalid host' }] },
			form: ['Other section failed'],
		})
	})
})
