import type { ConfigResultOk } from '@pluxel/services/management/client'

export function configSnapshot(
	input: Readonly<Record<string, unknown>> | null,
	overrides: Partial<ConfigResultOk> = {},
): ConfigResultOk {
	return {
		ok: true,
		readonly: false,
		mode: 'declared-first',
		managedInput: input,
		effectiveInput: input ?? {},
		config: input ?? {},
		sources: [],
		shadowedPaths: [],
		managedRevision: 'config:initial',
		desiredRevision: 1,
		appliedRevision: 1,
		application: 'applied',
		persistence: { status: 'unchanged' },
		...overrides,
	}
}

export function savedConfig(
	input: Readonly<Record<string, unknown>>,
	overrides: Partial<ConfigResultOk> = {},
): ConfigResultOk {
	return configSnapshot(input, {
		managedRevision: 'config:saved',
		persistence: { status: 'confirmed', retention: 'declared-durable' },
		...overrides,
	})
}
