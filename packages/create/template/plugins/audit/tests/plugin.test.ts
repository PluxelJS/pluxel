import { createTestHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { AuditPlugin } from '@example/audit-plugin'

describe('AuditPlugin', () => {
	it('runs without optional services', async () => {
		await using host = await createTestHost()

		const audit = await host.start(AuditPlugin)
		audit.record('example event')
		expect(audit.entries().map((entry) => entry.message)).toEqual(['example event'])
	})
})
