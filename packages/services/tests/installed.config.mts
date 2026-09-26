import { defineConfig } from 'vitest/config'

// Build packages first; this opt-in test exercises their packed consumer boundary.
export default defineConfig({ test: { include: ['tests/installed-services.smoke.mjs'] } })
