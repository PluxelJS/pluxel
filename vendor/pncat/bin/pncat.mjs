#!/usr/bin/env node
// Published Pluxel bundles pncat and does not need this source loader.
import { tsImport } from 'tsx/esm/api'

const { runCli } = await tsImport('../src/cli.ts', import.meta.url)
await runCli()
