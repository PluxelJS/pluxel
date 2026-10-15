import { build } from 'vite-plus/pack'

// Load framework-dependent pack configuration only after its task prerequisites finish.
await build({ config: process.argv[2] ?? 'tsdown.config.ts', watch: false })
