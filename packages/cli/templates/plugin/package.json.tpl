{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "{{packageName}}",
	"description": {{json description}},
	"version": "0.1.0",
	"type": "module",
	"exports": {
		".": {
			"@pluxel/hmr": "./src/{{pluginName}}.ts",
			"default": "./dist/index.mjs"
		}
	},
	"devEngines": {
		"packageManager": {
			"name": "pnpm",
			"version": ">=11 <12",
			"onFail": "error"
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
		"build": "pluxel build",
		"lint": "oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error src tests tsdown.config.ts vitest.config.ts oxlint.config.ts",
		"lint:fix": "pnpm lint --fix",
		"format": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --write .",
		"format:check": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --check .",
		"test": "vitest run",
		"test:watch": "vitest",
		"typecheck": "tsc --noEmit --pretty false",
		"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
	},
	"peerDependencies": {
		"@pluxel/runtime": "catalog:"
	},
	"devDependencies": {
		"@pluxel/cli": "catalog:",
		"@pluxel/core": "catalog:",
		"@pluxel/rolldown": "catalog:",
		"@pluxel/test": "catalog:",
		"oxfmt": "catalog:",
		"oxlint": "catalog:",
		"tsdown": "catalog:",
		"typescript": "catalog:",
		"vite": "catalog:",
		"vitest": "catalog:"
	}
}
