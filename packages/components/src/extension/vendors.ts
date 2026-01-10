// packages/components/src/extension/vendors.ts
// 共享依赖导出 - 供插件 UI 模块使用

import * as React from 'react'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import * as ReactJSXDevRuntime from 'react/jsx-dev-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as MantineCore from '@mantine/core'
import * as MantineHooks from '@mantine/hooks'
import * as MantineModals from '@mantine/modals'
import * as MantineNotifications from '@mantine/notifications'
import * as Capnweb from 'capnweb'
import { rpcErrorMessage } from '@pluxel/hmr-web'
import {
	definePluginUIModule,
	ExtensionPoints,
	doc,
	useExtensionContext,
	extensionVendorPackages,
} from '@pluxel/hmr-web'

function createJsxDevRuntimeVendor() {
	const vendor: Record<string, unknown> = { ...ReactJSXDevRuntime }
	const prodRuntime = ReactJSXRuntime as Record<string, unknown>

	if (typeof vendor.jsxDEV !== 'function' && typeof prodRuntime['jsx'] === 'function') {
		const jsx = prodRuntime['jsx'] as (...runtimeArgs: unknown[]) => unknown
		vendor.jsxDEV = (...args: unknown[]) => jsx(...args)
	}

	if (typeof vendor.jsxs !== 'function' && typeof prodRuntime['jsxs'] === 'function') {
		const jsxs = prodRuntime['jsxs'] as (...runtimeArgs: unknown[]) => unknown
		vendor.jsxs = (...args: unknown[]) => jsxs(...args)
	}

	if (typeof vendor.jsx !== 'function' && typeof prodRuntime['jsx'] === 'function') {
		const jsx = prodRuntime['jsx'] as (...runtimeArgs: unknown[]) => unknown
		vendor.jsx = (...args: unknown[]) => jsx(...args)
	}

	return vendor
}

const ReactJSXDevRuntimeVendor = createJsxDevRuntimeVendor()

/**
 * 共享依赖 vendors 对象
 *
 * 插件 UI 模块编译后会引用这些全局变量，
 * 而不是打包自己的 React/Mantine 副本。
 */
export const vendors = {
	react: React,
	'react/jsx-runtime': ReactJSXRuntime,
	'react/jsx-dev-runtime': ReactJSXDevRuntimeVendor,
	'react-dom': ReactDOM,
	'react-dom/client': ReactDOMClient,
	'@mantine/core': MantineCore,
	'@mantine/hooks': MantineHooks,
	'@mantine/modals': MantineModals,
	'@mantine/notifications': MantineNotifications,
	capnweb: Capnweb,
	// Extensions import from `@pluxel/hmr/web` (curated UI SDK surface).
	'@pluxel/hmr/web': {
		// plugin authoring + shared helpers
		ExtensionPoints,
		definePluginUIModule,
		doc,
		useExtensionContext,

		// web helpers
		rpcErrorMessage,
	},
	'@pluxel/hmr/capnweb': Capnweb,
}

export type Vendors = typeof vendors

declare global {
	// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
	interface Window {
		__PLUXEL_VENDORS__?: Vendors
	}
}

/**
 * 初始化 vendors 到全局
 *
 * 在应用入口调用，确保插件可以访问共享依赖
 */
export function initVendors(): void {
	if (typeof window !== 'undefined' && !window.__PLUXEL_VENDORS__) {
		window.__PLUXEL_VENDORS__ = vendors
	}
}

/**
 * 获取 vendor 模块
 *
 * 插件 runtime 用于解析 import
 */
export function getVendor(name: string): unknown {
	if (typeof window !== 'undefined' && window.__PLUXEL_VENDORS__) {
		return (window.__PLUXEL_VENDORS__ as Record<string, unknown>)[name]
	}
	return undefined
}

/**
 * 所有可用的 vendor 包名
 */
export const vendorPackages = extensionVendorPackages

export type VendorPackage = (typeof vendorPackages)[number]
