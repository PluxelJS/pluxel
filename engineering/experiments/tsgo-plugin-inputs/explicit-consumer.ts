// Import only emitted declarations, not the plugin source or a generated augmentation.
import {
	envBinding,
	ExamplePlugin,
	ExampleConfig,
	ExampleCredentials,
} from './.explicit-out/explicit-bindings.js'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const acceptedInput: StandardSchemaV1.InferInput<typeof ExampleConfig> = { payload: { raw: '42' } }
const acceptedOutput: StandardSchemaV1.InferOutput<typeof ExampleConfig> = {
	mode: 'dev',
	payload: 2,
}
void acceptedInput
void acceptedOutput

// @ts-expect-error Input preserves the pre-transform object, rather than the normalized number.
const badInput: StandardSchemaV1.InferInput<typeof ExampleConfig> = { payload: 42 }
void badInput
// @ts-expect-error A defaulted property is required in the normalized output.
const badOutput: StandardSchemaV1.InferOutput<typeof ExampleConfig> = { payload: 2 }
void badOutput

envBinding(ExamplePlugin, {
	config: {
		schema: ExampleConfig,
		mapping: {
			payload: { raw: 'APP_RAW' },
			transport: { endpoint: 'APP_ENDPOINT' },
		},
	},
	vault: { schema: ExampleCredentials, mapping: { credentials: { token: 'APP_TOKEN' } } },
})
envBinding(ExamplePlugin, {
	config: {
		schema: ExampleConfig,
		mapping: {
			// @ts-expect-error Wrong config key remains an error across the published declaration boundary.
			missing: 'APP_VALUE',
		},
	},
})
envBinding(ExamplePlugin, {
	vault: {
		schema: ExampleCredentials,
		mapping: {
			credentials: {
				// @ts-expect-error Wrong credential field remains an error across the published declaration boundary.
				password: 'APP_PASSWORD',
			},
		},
	},
})
envBinding(ExamplePlugin, {
	config: {
		schema: ExampleConfig,
		mapping: {
			payload: {
				// @ts-expect-error Completion/validation is based on input keys, not transformed output.
				length: 'APP_LENGTH',
			},
		},
	},
})

import { env, jsonFile } from './.explicit-out/explicit-bindings.js'
env(ExampleConfig, { payload: { raw: 'APP_RAW' } })
env(ExampleCredentials.entries.credentials, { token: 'APP_TOKEN' })
jsonFile(ExampleCredentials.entries.credentials, './credential.json')
// @ts-expect-error Minimal helper preserves nested input keys.
env(ExampleConfig, { payload: { length: 'APP_LENGTH' } })
// @ts-expect-error Minimal helper does not widen schema from a wrong mapping.
env(ExampleCredentials.entries.credentials, { password: 'APP_PASSWORD' })
