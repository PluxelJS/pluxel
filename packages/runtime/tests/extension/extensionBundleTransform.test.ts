import { describe, expect, it } from 'vitest'
import {
	normalizeJsxRuntime,
	transformVendorImports,
} from '../../src/services/plugin-interaction/extensionBundleTransform'

describe('extension bundle vendor transform', () => {
	it('rewrites host-provided vendor imports to window globals', () => {
		const input = [
			'import { definePluginUIModule, rpcErrorMessage, useExtensionContext } from "@pluxel/runtime/web";',
			'import * as Capnweb from "capnweb";',
			'import React, { useMemo as useMemo2 } from "react";',
			'import { Button } from "@mantine/core";',
			'import "react/jsx-runtime";',
			'export const ok = Boolean(definePluginUIModule && rpcErrorMessage && useExtensionContext && Capnweb && React && useMemo2 && Button);',
		].join('\n')

		const out = normalizeJsxRuntime(transformVendorImports(input))
		expect(out).toContain('window.__PLUXEL_VENDORS__["@pluxel/runtime/web"]')
		expect(out).toContain('window.__PLUXEL_VENDORS__["capnweb"]')
		expect(out).toContain('window.__PLUXEL_VENDORS__["react"]')
		expect(out).toContain('window.__PLUXEL_VENDORS__["@mantine/core"]')
		expect(out).not.toContain('import { definePluginUIModule')
		expect(out).not.toContain('import * as Capnweb')
		expect(out).not.toContain('import React')
		expect(out).not.toContain('import { Button')
		expect(out).not.toContain('import "react/jsx-runtime"')
	})
})
