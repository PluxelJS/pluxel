import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication, envBinding, type HostApplicationFactory } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { PlaywrightConfig, PlaywrightPlugin } from '@pluxel/playwright'
import { InvoicePlugin, InvoiceVaultSchema } from '@pluxel/invoice'
import { InvoiceConsumer } from './consumer.ts'

const application: HostApplicationFactory = defineHostApplication((startup) => ({
	plugins: [PlaywrightPlugin, InvoicePlugin, InvoiceConsumer],
	services: [vault({ backend: 'bindings' })],
	state: { initial: { autoStart: [pluginNodeAddressOf(InvoiceConsumer)] } },
	configRecords: {
		initial: [
			{
				owner: pluginNodeAddressOf(InvoicePlugin),
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
	envBindings: [
		envBinding(PlaywrightPlugin, {
			config: { schema: PlaywrightConfig, mapping: { endpoint: 'BROWSER_ENDPOINT' } },
		}),
		envBinding(InvoicePlugin, {
			vault: { schema: InvoiceVaultSchema, mapping: { primary: { apiKey: 'INVOICE_VLM_KEY' } } },
		}),
	],
}))

export default application
