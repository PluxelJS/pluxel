import { withHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { AuditPlugin } from '@example/audit-plugin'

describe('AuditPlugin', () => {
	it('can be tested with the core-only host', async () => {
		await withHost(async (host) => {
			host.add(AuditPlugin)
			await host.commit()

			const audit = host.require(AuditPlugin)
			audit.record('example event')
			expect(audit.entries().map((entry) => entry.message)).toEqual(['example event'])
		})
	})
})
