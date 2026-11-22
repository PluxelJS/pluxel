import { build } from 'vite-plus/pack'

// Match Vite configuration resolution for relative TypeScript imports after task prerequisites finish.
await build({ config: process.argv[2] ?? 'tsdown.config.ts', configLoader: 'tsx', watch: false })
