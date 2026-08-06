import type { PluginConstructor } from '@pluxel/core'

export type BuiltinForkSpec = string | Readonly<{ id: string; enable?: boolean }>

/** A host-owned plugin constructor that is available before mutable sources are loaded. */
export type BuiltinPluginSpec =
	| PluginConstructor
	| Readonly<{
			plugin: PluginConstructor
			enable?: boolean
			/**
			 * Diagnostic module identity for the builtin declaration.
			 *
			 * @defaultValue "pluxel:builtins"
			 */
			moduleId?: string
			/**
			 * Workspace package omitted from mutable workspace discovery to prevent duplicate loading.
			 */
			packageName?: string
			/**
			 * Export name within `moduleId`.
			 *
			 * @defaultValue "default"
			 */
			exportKey?: string
			forks?: readonly BuiltinForkSpec[]
	  }>

/** A prebuilt workspace plugin module used as a stable dynamic-host baseline. */
export type BuiltinDistPluginSpec = Readonly<{
	/** Workspace package name and diagnostic module identity. */
	packageName: string
	/** Absolute path, or a path resolved relative to the dynamic runtime root. */
	entry: string
	/** Named plugin export. When omitted, all decorated named exports are discovered. */
	exportKey?: string
	/** Whether the discovered builtin is enabled on first use. @defaultValue true */
	enable?: boolean
}>
