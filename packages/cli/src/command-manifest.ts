import { lazy } from 'gunshi'

export const newCommandArgs = {
	dest: {
		type: 'positional',
		multiple: true,
		description: 'Destination base dir (relative to --root; auto when omitted)',
	},
	root: { type: 'string', description: 'Workspace root (auto-detect by default)' },
	template: { type: 'string', description: 'Template name or path (auto/prompt by default)' },
	pm: {
		type: 'enum',
		description: 'Package manager (auto-detect by default)',
		choices: ['pnpm', 'npm', 'yarn'],
	},
	force: { type: 'boolean', description: 'Overwrite existing files', default: false },
	install: {
		type: 'boolean',
		description: 'Install dependencies after generation',
		default: true,
		negatable: true,
	},
	'dry-run': {
		type: 'boolean',
		description: 'Show the plan without touching the filesystem',
		default: false,
	},
	name: { type: 'string', description: 'Full npm name or short name, e.g. @scope/foo or foo' },
} as const

export const newCommandDefinition = {
	name: 'new',
	description: 'Scaffold from templates',
	toKebab: true,
	args: newCommandArgs,
} as const

export const buildCommandArgs = {
	watch: { type: 'boolean', description: 'Enable watch mode', default: false },
	debug: {
		type: 'boolean',
		description: 'Print resolved tsdown config before running',
		default: false,
	},
} as const

export const buildCommandDefinition = {
	name: 'build',
	description: 'Build current project',
	args: buildCommandArgs,
} as const

export const databaseCommonArgs = {
	root: { type: 'string', description: 'Plugin package root', default: '.' },
	schema: { type: 'string', description: 'Database schema module (auto-detected by default)' },
	out: { type: 'string', description: 'Migration directory', default: 'drizzle' },
} as const

export const databaseGenerateArgs = {
	...databaseCommonArgs,
	name: { type: 'string', description: 'Migration name passed to Drizzle Kit' },
} as const

export const databaseGenerateDefinition = {
	name: 'generate',
	description: 'Generate a checked-in PostgreSQL migration',
	args: databaseGenerateArgs,
} as const

export const databaseCheckDefinition = {
	name: 'check',
	description: 'Validate migration history, checksums, and schema drift',
	args: databaseCommonArgs,
} as const

export const databaseRebaseArgs = {
	...databaseGenerateArgs,
	lineage: { type: 'string', description: 'New immutable database lineage' },
} as const

export const databaseRebaseDefinition = {
	name: 'rebase',
	description: 'Start a fresh database lineage while preserving deployed instances',
	args: databaseRebaseArgs,
} as const

export const databaseSubCommands = new Map([
	[
		'generate',
		lazy(
			() => import('./commands/database').then((module) => module.databaseGenerateCommand),
			databaseGenerateDefinition,
		),
	],
	[
		'check',
		lazy(
			() => import('./commands/database').then((module) => module.databaseCheckCommand),
			databaseCheckDefinition,
		),
	],
	[
		'rebase',
		lazy(
			() => import('./commands/database').then((module) => module.databaseRebaseCommand),
			databaseRebaseDefinition,
		),
	],
])

export const databaseCommandDefinition = {
	name: 'database',
	description: 'Generate and validate plugin database migrations',
	args: databaseCommonArgs,
	subCommands: databaseSubCommands,
} as const

export const distributionRootArgs = {
	root: { type: 'positional', description: 'Unpacked distribution root', default: '.' },
} as const

export const distributionCreateDefinition = {
	name: 'create',
	description: 'Create the deterministic artifact manifest for a finalized distribution',
	args: distributionRootArgs,
} as const

export const distributionInspectDefinition = {
	name: 'inspect',
	description: 'Compare a distribution with its artifact manifest without authenticating an issuer',
	args: distributionRootArgs,
} as const

export const distributionVerifyArgs = {
	...distributionRootArgs,
	key: {
		type: 'string',
		multiple: true,
		description: 'Trusted issuer public key PEM (repeatable)',
	},
	report: { type: 'string', description: 'Write the versioned verification report as JSON' },
} as const

export const distributionVerifyDefinition = {
	name: 'verify',
	description: 'Verify DSSE issuer trust, signed manifest digest, and the complete artifact set',
	args: distributionVerifyArgs,
} as const

export const distributionMarkArgs = {
	...distributionRootArgs,
	claims: { type: 'string', description: 'Private release claims JSON path' },
	'record-out': { type: 'string', description: 'Private delivery record output path' },
} as const

export const distributionMarkDefinition = {
	name: 'mark',
	description: 'Add one inert random delivery marker before artifact finalization',
	toKebab: true,
	args: distributionMarkArgs,
} as const

export const distributionCorrelateArgs = {
	...distributionRootArgs,
	'delivery-record': { type: 'string', description: 'Private delivery record JSON path' },
	report: { type: 'string', description: 'Write the correlation result as JSON' },
} as const

export const distributionCorrelateDefinition = {
	name: 'correlate',
	description: 'Compare an inert delivery marker with one private delivery record',
	toKebab: true,
	args: distributionCorrelateArgs,
} as const

export const distributionSubCommands = new Map([
	[
		'create',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionCreateCommand),
			distributionCreateDefinition,
		),
	],
	[
		'inspect',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionInspectCommand),
			distributionInspectDefinition,
		),
	],
	[
		'verify',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionVerifyCommand),
			distributionVerifyDefinition,
		),
	],
	[
		'mark',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionMarkCommand),
			distributionMarkDefinition,
		),
	],
	[
		'correlate',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionCorrelateCommand),
			distributionCorrelateDefinition,
		),
	],
])

export const distributionCommandDefinition = {
	name: 'distribution',
	description: 'Create, inspect, verify, and correlate static application distributions',
	args: distributionRootArgs,
	subCommands: distributionSubCommands,
} as const

export const publishCommandArgs = {
	access: { type: 'string', description: 'npm publish --access value', default: 'public' },
	'dry-run': { type: 'boolean', description: 'Plan publish without executing', default: false },
	debug: {
		type: 'boolean',
		description: 'Print npm args/env keys before running publish',
		default: false,
	},
	webhook: {
		type: 'boolean',
		description: 'Notify market webhook even if npm publish is skipped (requires OIDC token)',
		default: false,
	},
	'skip-version-check': {
		type: 'boolean',
		description: 'Skip checking if version already published',
		default: false,
	},
} as const

export const publishCommandDefinition = {
	name: 'publish',
	description: 'Publish current package to npm and notify market',
	toKebab: true,
	args: publishCommandArgs,
} as const

export const loaderHmrCommonArgs = {
	root: { type: 'string', description: 'Workspace root', default: '.' },
	config: {
		type: 'string',
		description: 'Config file path',
		default: 'pluxel.loader.hmr.jsonc',
	},
	profile: { type: 'string', description: 'Profile name (overrides config.profile for this run)' },
} as const

export const loaderHmrSetArgs = {
	...loaderHmrCommonArgs,
	set: {
		type: 'string',
		description:
			'Non-interactive package list (comma or newline separated). Writes config directly.',
	},
} as const

export const loaderHmrPromptDefinition = {
	name: 'prompt',
	description: 'Open interactive loader HMR prompt',
	toKebab: true,
	args: loaderHmrCommonArgs,
} as const

export const loaderHmrDoctorDefinition = {
	name: 'doctor',
	description: 'Diagnose workspace and print loader HMR summary',
	toKebab: true,
	args: loaderHmrCommonArgs,
} as const

export const loaderHmrEnabledDefinition = {
	name: 'enabled',
	description: 'Edit enabled plugin set (TUI or --set)',
	toKebab: true,
	args: loaderHmrSetArgs,
} as const

export const loaderHmrBuiltinDefinition = {
	name: 'builtin',
	description: 'Edit builtin plugin set (TUI or --set)',
	toKebab: true,
	args: loaderHmrSetArgs,
} as const

export const hmrSubCommands = new Map([
	[
		'prompt',
		lazy(
			() => import('./commands/hmr').then((module) => module.loaderHmrPromptCommand),
			loaderHmrPromptDefinition,
		),
	],
	[
		'doctor',
		lazy(
			() => import('./commands/hmr').then((module) => module.loaderHmrDoctorCommand),
			loaderHmrDoctorDefinition,
		),
	],
	[
		'enabled',
		lazy(
			() => import('./commands/hmr').then((module) => module.loaderHmrEnabledCommand),
			loaderHmrEnabledDefinition,
		),
	],
	[
		'builtin',
		lazy(
			() => import('./commands/hmr').then((module) => module.loaderHmrBuiltinCommand),
			loaderHmrBuiltinDefinition,
		),
	],
])

export const hmrCommandDefinition = {
	name: 'hmr',
	description: 'Loader HMR workspace profiles',
	toKebab: true,
	args: loaderHmrCommonArgs,
	subCommands: hmrSubCommands,
} as const

export const workspaceRootArgs = {
	root: { type: 'string', description: 'Workspace root', default: '.' },
} as const

export const workspacePatternArgs = {
	...workspaceRootArgs,
	pattern: { type: 'positional', description: 'Workspace pattern or folder to mutate' },
} as const

export const workspacePullArgs = {
	...workspaceRootArgs,
	repo: { type: 'positional', description: 'Git URL to clone' },
	dir: {
		type: 'string',
		description: 'Destination base dir for pull (relative to root)',
		default: 'packages',
	},
	name: { type: 'string', description: 'Folder name for pull (auto from repo name by default)' },
	ref: { type: 'string', description: 'Git ref/branch for pull' },
	force: { type: 'boolean', description: 'Overwrite existing folder for pull', default: false },
} as const

export const workspaceScanArgs = {
	...workspaceRootArgs,
	base: { type: 'positional', description: 'Base directory to scan (relative to root)' },
} as const

export const workspacePromptDefinition = {
	name: 'prompt',
	description: 'Interactive workspace toggler',
	toKebab: true,
	args: workspaceRootArgs,
} as const

export const workspaceListDefinition = {
	name: 'list',
	description: 'List active workspace patterns and detected packages',
	toKebab: true,
	args: workspaceRootArgs,
} as const

export const workspaceAddDefinition = {
	name: 'add',
	description: 'Add/enable a workspace pattern',
	toKebab: true,
	args: workspacePatternArgs,
} as const

export const workspaceRemoveDefinition = {
	name: 'remove',
	description: 'Remove/disable a workspace pattern',
	toKebab: true,
	args: workspacePatternArgs,
} as const

export const workspacePullDefinition = {
	name: 'pull',
	description: 'Clone a repository and add it to workspace patterns',
	toKebab: true,
	args: workspacePullArgs,
} as const

export const workspaceScanDefinition = {
	name: 'scan',
	description: 'Scan directories and refresh workspace candidate cache',
	toKebab: true,
	args: workspaceScanArgs,
} as const

export const workspaceSubCommands = new Map([
	[
		'prompt',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspacePromptCommand),
			workspacePromptDefinition,
		),
	],
	[
		'list',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspaceListCommand),
			workspaceListDefinition,
		),
	],
	[
		'add',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspaceAddCommand),
			workspaceAddDefinition,
		),
	],
	[
		'remove',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspaceRemoveCommand),
			workspaceRemoveDefinition,
		),
	],
	[
		'pull',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspacePullCommand),
			workspacePullDefinition,
		),
	],
	[
		'scan',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspaceScanCommand),
			workspaceScanDefinition,
		),
	],
])

export const workspaceCommandDefinition = {
	name: 'workspace',
	description: 'Manage workspaces (pnpm / yarn)',
	toKebab: true,
	args: workspaceRootArgs,
	subCommands: workspaceSubCommands,
} as const
