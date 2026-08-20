import { BasePlugin, Plugin } from '@pluxel/runtime'

export type AuditEntry = Readonly<{
	message: string
	recordedAt: number
}>

@Plugin({ displayName: 'Example audit log' })
export class AuditPlugin extends BasePlugin {
	private readonly history: AuditEntry[] = []

	record(message: string): void {
		this.history.push({ message, recordedAt: Date.now() })
	}

	entries(): readonly AuditEntry[] {
		return this.history.map((entry) => ({ ...entry }))
	}
}
