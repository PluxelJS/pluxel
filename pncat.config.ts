import { defineConfig, mergeCatalogRules } from 'pncat'

const CLI_PACKAGES: (string | RegExp)[] = ['commander', 'inquirer', 'node-plop', 'nypm']
const BUILD_PACKAGES: (string | RegExp)[] = ['@hono/vite-dev-server', '@rolldown/pluginutils']
const FRONTEND_PACKAGES: (string | RegExp)[] = [
	/^@mantine\//,
	/^@dnd-kit\//,
	'@tanstack/react-form',
	'@tanstack/react-router',
	'@tanstack/react-virtual',
]
const BACKEND_PACKAGES: (string | RegExp)[] = [
	'hono',
	'@hono/node-server',
	'@hono/valibot-validator',
]
const GRAPHQL_PACKAGES: (string | RegExp)[] = [
	'@gqlens/codegen',
	'@gqlens/core',
	'@gqlens/react',
	'@gqloom/core',
	'@gqloom/valibot',
	'graphql',
	'graphql-scalars',
	'graphql-yoga',
]
const VALIDATION_PACKAGES: (string | RegExp)[] = [
	'valibot',
	'option-t',
	'reflect-metadata',
	'superjson',
]
const LOGGING_PACKAGES: (string | RegExp)[] = [
	'pino',
	'pino-pretty',
	'pino-caller',
	'rotating-file-stream',
	'@poppinss/dumper',
	'youch',
]
const WORKFLOW_PACKAGES: (string | RegExp)[] = ['exsolve', 'knitwork', '@tanstack/pacer', 'xstate']
const NODE_RUNTIME_PACKAGES: (string | RegExp)[] = ['chokidar', 'pathe', 'pkg-types']

export default defineConfig({
	catalogRules: mergeCatalogRules([
		{
			name: 'build',
			match: BUILD_PACKAGES,
		},
		{
			name: 'cli',
			match: CLI_PACKAGES,
		},
		{
			name: 'frontend',
			match: FRONTEND_PACKAGES,
		},
		{
			name: 'backend',
			match: BACKEND_PACKAGES,
			priority: 40,
		},
		{
			name: 'graphql',
			match: GRAPHQL_PACKAGES,
			priority: 32,
		},
		{
			name: 'validation',
			match: VALIDATION_PACKAGES,
			priority: 34,
		},
		{
			name: 'logging',
			match: LOGGING_PACKAGES,
			priority: 36,
		},
		{
			name: 'workflow',
			match: WORKFLOW_PACKAGES,
			priority: 38,
		},
		{
			name: 'node',
			match: NODE_RUNTIME_PACKAGES,
		},
	]),
})
