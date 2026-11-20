import { expect, it } from 'vitest'
import * as v from 'valibot'
import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/core'
import { createCoreTestHost } from '@pluxel/core/internal/test'

const Connection = v.object({ available: v.boolean() })

@Plugin()
export class AuditDatabase extends BasePlugin {
	private readonly config = this.configs.use(Connection)
	readonly entries: string[] = []

	protected override init() {
		if (!this.config.available) throw new Error('audit database unavailable')
	}

	record(entry: string) {
		this.entries.push(entry)
	}
}

@Plugin()
export class AuditTrail extends BasePlugin {
	readonly sessions = new Set<string>()

	constructor(private readonly database: AuditDatabase) {
		super()
	}

	openSession(source: string) {
		const sessions = this.sessions
		sessions.add(source)
		return () => {
			sessions.delete(source)
		}
	}

	record(entry: string) {
		this.database.record(entry)
	}
}

@Plugin()
export class InvoiceTimeline extends BasePlugin {
	readonly invoices: string[] = []
	add(invoice: string) {
		this.invoices.push(invoice)
	}
}

const Audit = definePluginRef<AuditTrail>()
const Timeline = definePluginRef<InvoiceTimeline>()
let integrationStarts = 0

class LedgerIntegration extends PluginPart<Ledger> {
	private audit?: AuditTrail
	private timeline?: InvoiceTimeline

	protected override init() {
		integrationStarts++
		this.plugins.use(Audit, (audit) => {
			this.audit = audit
			return audit.openSession('ledger')
		})
		this.plugins.use(Timeline, (timeline) => {
			this.timeline = timeline
		})
	}

	record(invoice: string) {
		this.audit?.record(invoice)
		this.timeline?.add(invoice)
	}
}

@Plugin()
export class Ledger extends BasePlugin {
	private readonly integration = this.parts.use(LedgerIntegration)

	post(invoice: string) {
		this.integration.record(invoice)
		return invoice
	}
}

@Plugin()
export class InvoiceApi extends BasePlugin {
	constructor(private readonly ledger: Ledger) {
		super()
	}

	post(invoice: string) {
		return this.ledger.post(invoice)
	}
}

it('keeps invoices available as optional integrations connect, restart and lose a provider', async () => {
	integrationStarts = 0
	await using host = createCoreTestHost()
	const invoiceApi = InvoiceApi.nodeAddress()
	const auditTrail = AuditTrail.nodeAddress()
	const database = AuditDatabase.nodeAddress()
	const timeline = InvoiceTimeline.nodeAddress()
	const [, offline] = await host.add([Ledger.nodeAddress(), invoiceApi])
	expect(offline.post('first')).toBe('first')
	expect(host.isRunning(auditTrail)).toBe(false)

	await host.commitExpectFail((change) => {
		change.add(database, { initialConfig: { available: false } })
		return change.add(auditTrail)
	})
	await host.commitExpectFail((change) => change.add(auditTrail))
	expect(host.require(invoiceApi)).toBe(offline)

	await host.commit((change) => {
		change.config.patch(database, { available: true })
		return change.add(timeline)
	})
	expect(integrationStarts).toBe(2)
	const audit = host.require(auditTrail)
	const connected = host.require(invoiceApi)
	expect(() => offline.post('stale')).toThrow(/stopped|withdrawn/i)
	expect(connected.post('second')).toBe('second')
	expect(audit.sessions).toEqual(new Set(['ledger']))
	expect(host.require(database).entries).toEqual(['second'])
	expect(host.require(timeline).invoices).toEqual(['second'])

	const replacement = await host.restart(auditTrail)
	expect(audit.sessions.size).toBe(0)
	const reconnected = host.require(invoiceApi)
	expect(reconnected.post('third')).toBe('third')
	expect(replacement.sessions).toEqual(new Set(['ledger']))
	expect(host.require(database).entries).toEqual(['second', 'third'])

	await host.remove(database)
	expect(host.isRunning(auditTrail)).toBe(false)
	expect(replacement.sessions.size).toBe(0)
	expect(() => reconnected.post('stale')).toThrow(/stopped|withdrawn/i)
	const disconnected = host.require(invoiceApi)
	expect(disconnected.post('fourth')).toBe('fourth')
	expect(host.require(timeline).invoices).toEqual(['second', 'third', 'fourth'])
})
