import * as core from '@pluxel/core'
import * as toolchain from '@pluxel/core/toolchain'
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto'
import { File, Paths } from 'expo-file-system'
import type * as PluginExports from './index'

const selected = () => new File(Paths.document, 'device-language.pluxel.json')

async function readArtifact(file: File) {
	const data = JSON.parse(await file.text())
	if (data?.format !== 1 || typeof data.code !== 'string' || typeof data.sha256 !== 'string')
		throw new Error('Expected a Pluxel example plugin file (format 1)')
	const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, data.code)
	if (digest !== data.sha256) throw new Error('The plugin bytes do not match their SHA-256 digest')
	return { code: data.code as string, sha256: digest }
}

export async function installPlugin() {
	const result = await File.pickFileAsync({ mimeTypes: 'application/json' })
	if (result.canceled) return false
	const stage = new File(Paths.document, 'device-language.pending')
	const active = selected()
	if (active.exists) throw new Error('Remove the current plugin before installing another')
	try {
		if (stage.exists) stage.delete()
		await result.result.copy(stage)
		await readArtifact(stage)
		await stage.move(active)
	} finally {
		// move() updates the File's URI; clean up the staging path only.
		const leftover = new File(Paths.document, 'device-language.pending')
		if (leftover.exists) leftover.delete()
	}
	return true
}

export function uninstallPlugin() {
	selected().delete()
}

export async function loadInstalledPlugin() {
	const file = selected()
	if (!file.exists) return
	const { code, sha256 } = await readArtifact(file)
	// The user explicitly selected a trusted local file. It runs in the application's JS realm.
	const module = { exports: {} as typeof PluginExports }
	const execute = new Function('module', 'exports', 'require', code)
	execute(module, module.exports, (name: string) => {
		if (name === '@pluxel/core') return core
		if (name === '@pluxel/core/toolchain') return toolchain
		throw new Error(`The host does not supply ${name}`)
	})
	const plugin = module.exports
	if (typeof plugin.DeviceLocales !== 'function' || typeof plugin.DeviceLanguage !== 'function')
		throw new Error('Expected the DeviceLocales service token and DeviceLanguage plugin')
	return { plugin, sha256 }
}

export function hasInstalledPlugin() {
	return selected().exists
}
