import { type ArgValues, define } from 'gunshi'
import { publishWorkspaces } from '../publish'
import { CLI_DEFAULTS, resolvePublishEnv } from '../config'

const publishArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	base: {
		type: 'string',
		description: 'Base directory to scan for packages',
		default: CLI_DEFAULTS.publish.base,
	},
	registry: {
		type: 'string',
		description: `Custom npm registry for view/publish (env: ${CLI_DEFAULTS.publish.registryEnv})`,
	},
	webhook: {
		type: 'string',
		description: `Market base URL override (env: ${CLI_DEFAULTS.publish.webhookEnv})`,
	},
	access: {
		type: 'string',
		description: 'npm publish --access value',
		default: CLI_DEFAULTS.publish.access,
	},
	dryRun: {
		type: 'boolean',
		description: 'Plan publish without executing',
		default: false,
	},
	audience: {
		type: 'string',
		description: `OIDC audience for webhook and provenance (env: ${CLI_DEFAULTS.publish.audienceEnv})`,
	},
	marketBase: {
		type: 'string',
		description: `Market RPC base URL (env: ${CLI_DEFAULTS.publish.marketBaseEnv}, default: ${CLI_DEFAULTS.publish.marketBaseUrl})`,
	},
} as const

type PublishArgs = typeof publishArgs
type PublishValues = ArgValues<PublishArgs>

export const publishCommand = define({
	name: 'publish',
	description: 'Publish workspace packages when version changes',
	args: publishArgs,
	async run(ctx) {
		const values = ctx.values as PublishValues
		const envDefaults = resolvePublishEnv()
		await publishWorkspaces({
			root: values.root,
			base: values.base,
			registry: values.registry ?? envDefaults.registry,
			webhook: values.webhook ?? envDefaults.webhook,
			access: values.access,
			audience: values.audience ?? envDefaults.audience,
			dryRun: values.dryRun,
			marketBaseUrl: values.marketBase ?? envDefaults.marketBaseUrl ?? CLI_DEFAULTS.publish.marketBaseUrl,
			log: ctx.log,
		})
	},
})
