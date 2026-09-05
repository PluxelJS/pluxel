{
	"$schema": "https://market.pluxel.dev/schema/package.json",
	"name": "{{packageName}}",
	"description": {{json description}},
	"version": "0.1.0",
	"type": "module",
	"packageManager": "pnpm@11.25.0",
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
		"build": "pluxel build",
		"lint": "oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error src tests tsdown.config.ts vitest.config.ts oxlint.config.ts",
		"lint:fix": "pnpm lint --fix",
		"format": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --write .",
		"format:check": "oxfmt -c .oxfmtrc.json --ignore-path .gitignore --check .",
		"governance:check": "pluxel workspace doctor",
		"test": "vitest run",
		"test:watch": "vitest",
		"typecheck": "tsc --noEmit --pretty false",
		"verify": "pnpm governance:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
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
