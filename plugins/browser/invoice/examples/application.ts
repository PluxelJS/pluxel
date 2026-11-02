import { defineHostApplication, envBinding, type HostApplicationFactory } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { PlaywrightConfig, PlaywrightPlugin } from '@pluxel/plugin-playwright'
import { InvoicePlugin, InvoiceVaultSchema } from '@pluxel/plugin-invoice'
import { InvoiceConsumer } from './consumer.ts'

const application: HostApplicationFactory = defineHostApplication((startup) => ({
	plugins: [PlaywrightPlugin, InvoicePlugin, InvoiceConsumer],
	services: [vault({ backend: 'bindings' })],
	envBindings: [
		envBinding(PlaywrightPlugin, {
			config: { schema: PlaywrightConfig, mapping: { endpoint: 'BROWSER_ENDPOINT' } },
		}),
		envBinding(InvoicePlugin, {
			vault: { schema: InvoiceVaultSchema, mapping: { primary: { apiKey: 'INVOICE_VLM_KEY' } } },
		}),
	],
	runtime: {
		state: { autoStart: [InvoiceConsumer.nodeAddress()] },
		configRecords: {
			records: [
				{
					owner: InvoicePlugin.nodeAddress(),
					config: {
						vlm: {
							endpoint: startup.env.INVOICE_VLM_ENDPOINT,
							model: startup.env.INVOICE_VLM_MODEL,
							credentialKey: 'primary',
						},
						captchaAttempts: 1,
					},
				},
			],
		},
	},
}))

export default application
