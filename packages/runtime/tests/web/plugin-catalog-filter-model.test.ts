import { describe, expect, it } from 'vitest'
import {
	DEFAULT_STATUS_FILTER,
	hasActiveSearchTokens,
	hasActiveStatusFilter,
	matchesGroupSearch,
	matchesPluginSearch,
} from '../../../components/src/app/plugins/catalog/filterModel'
import { parseSearchTokens } from '../../../components/src/app/plugins/catalog/searchTokens'

describe('plugin catalog filter model', () => {
	it('detects active token and status filters consistently', () => {
		expect(hasActiveSearchTokens(parseSearchTokens(''))).toBe(false)
		expect(hasActiveSearchTokens(parseSearchTokens('alpha @demo'))).toBe(true)
		expect(hasActiveStatusFilter(DEFAULT_STATUS_FILTER)).toBe(false)
		expect(
			hasActiveStatusFilter({
				...DEFAULT_STATUS_FILTER,
				disabled: false,
			}),
		).toBe(true)
	})

	it('matches groups only against plain search tokens', () => {
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('alpha tools'))).toBe(true)
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('@pkg'))).toBe(false)
	})

	it('applies the same AND semantics across text and status filters', () => {
		const tokens = parseSearchTokens('alpha @demo #stable v:1.2 id:plugin')
		const status = {
			name: 'Alpha Runner',
			packageName: '@demo/plugin-alpha',
			tag: 'stable',
			version: '1.2.3',
			isRunning: true,
			isEnabled: true,
		}

		expect(matchesPluginSearch('plugin-alpha', status, tokens, DEFAULT_STATUS_FILTER)).toBe(true)
		expect(
			matchesPluginSearch(
				'plugin-alpha',
				{
					...status,
					tag: 'beta',
				},
				tokens,
				DEFAULT_STATUS_FILTER,
			),
		).toBe(false)
		expect(
			matchesPluginSearch('plugin-alpha', status, tokens, {
				running: false,
				stopped: true,
				disabled: false,
			}),
		).toBe(false)
	})
})
