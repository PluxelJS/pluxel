import type { Identifier, Newable } from '../container'
import type { BasePlugin } from './BasePlugin'

export type * from '../container'
export type PluginClass = Newable<BasePlugin>

export type PluginIdentifier = Identifier<BasePlugin>

export type PluginInstance = BasePlugin

export * from 'option-t/plain_result'
