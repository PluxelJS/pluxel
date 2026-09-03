import { createCoreTestHost } from '@pluxel/core/test'
import { describe, expect, it } from 'vitest'
import { AuditPlugin } from '@example/audit-plugin'

describe('AuditPlugin', () => {
	it('can be tested with the core-only host', async () => {
		await using host = createCoreTestHost()

		const audit = await host.add(AuditPlugin)
		audit.record('example event')
		expect(audit.entries().map((entry) => entry.message)).toEqual(['example event'])
	})
})
