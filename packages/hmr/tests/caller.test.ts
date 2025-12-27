import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { withCallerFormatters } from '../src/services/logger/pretty/caller'

describe('pretty/caller', () => {
	it('skips internal frames when Error.prepareStackTrace is customized', () => {
		const testFile = fileURLToPath(import.meta.url)
		const externalLoc = `${testFile}:123:45`
		const originalPrepare = Error.prepareStackTrace
		try {
			Error.prepareStackTrace = () =>
				[
					'Error',
					'    at BotLayer initialized (nc (/virtual/services/logger/pretty/caller.ts:153:26))',
					`    at externalTest (nc (${externalLoc}))`,
				].join('\n')

			const formatters = withCallerFormatters(undefined, {
				enabled: true,
				skipCompiled: false,
				compiledHints: [],
			})
			const out = formatters?.log?.({}) as Record<string, unknown>
			expect(out.caller).toBe(`externalTest (${externalLoc})`)
		} finally {
			Error.prepareStackTrace = originalPrepare
		}
	})
})

