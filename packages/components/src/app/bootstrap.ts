import * as valibot from 'valibot'
import * as valibotForm from 'valibot-form'

declare global {
	// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
	interface GlobalThis {
		__PLUXEL_SCHEMA_VENDORS__?: {
			valibot: typeof valibot
			valibotForm: typeof valibotForm
		}
	}
}

const schemaVendors = { valibot, valibotForm } as const

function ensureSchemaVendors() {
	if (typeof globalThis === 'undefined') return
	const target = globalThis as typeof globalThis & {
		__PLUXEL_SCHEMA_VENDORS__?: typeof schemaVendors
	}
	if (!target.__PLUXEL_SCHEMA_VENDORS__) {
		target.__PLUXEL_SCHEMA_VENDORS__ = schemaVendors
	}
}

export function bootstrapAppEnvironment() {
	ensureSchemaVendors()
}

bootstrapAppEnvironment()
