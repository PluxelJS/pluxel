{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "{{packageName}}",
	"description": {{json description}},
	"version": "0.1.0",
	"type": "module",
	"packageManager": "pnpm@11.28.10",
	"exports": {
		".": {
			"@pluxel/hmr": "./src/{{pluginName}}.ts",
			"default": "./dist/index.mjs"
		}
	},
	"engines": {
		"node": ">=24"
	},
	"files": [
		"dist",
		"!**/*.map"
	],
	"scripts": {
		"setup": "pluxel workspace setup",
		"hooks:install": "hk install",
		"check": "vp check",
		"fix": "vp check --fix",
		"verify": "vp run workspace:verify",
		"build": "vp run compile",
		"test": "vp run check-tests",
		"typecheck": "vp run check-types"
	},
	"dependencies": {
		"valibot": "catalog:"
	},
	"peerDependencies": {
		"@pluxel/core": "catalog:",
		"@pluxel/host": "catalog:"
	},
	"peerDependenciesMeta": {
		"@pluxel/host": {
			"optional": true
		}
	},
	"devDependencies": {
		"@pluxel/agent-sdk": "catalog:",
		"@pluxel/cli": "catalog:",
		"@pluxel/core": "catalog:",
		"@pluxel/host": "catalog:",
		"@pluxel/rolldown": "catalog:",
		"@pluxel/test": "catalog:",
		"typescript": "catalog:",
		"vite-plus": "catalog:",
		"vite": "catalog:",
		"vitest": "catalog:"
	}
}
