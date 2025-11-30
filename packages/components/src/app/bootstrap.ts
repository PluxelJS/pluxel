import * as valibot from 'valibot'
import * as valibotForm from 'valibot-form'
import { initVendors } from '../extension'

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
	if (!globalThis.__PLUXEL_SCHEMA_VENDORS__) {
		globalThis.__PLUXEL_SCHEMA_VENDORS__ = schemaVendors
	}
}

function ensureExtensionVendors() {
	initVendors()
}

export function bootstrapAppEnvironment() {
	ensureSchemaVendors()
	ensureExtensionVendors()
}

bootstrapAppEnvironment()
