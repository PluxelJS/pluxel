/** Canonical public Script SDK namespace shared by Node artifacts and Vite modules. */
export type * from './agent'
export { createScriptScope, type ScriptScope, type ScriptRevisions } from './agent/sdk'
export { ScriptError } from './agent/sdk-outcomes'
