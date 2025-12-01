// packages/hmr/tests/plugins/ui/index.tsx
// 插件 UI 扩展入口模块
const {Badge, Button, Paper, Text, Group, Stack} = window.__PLUXEL_VENDORS__["@mantine/core"];
import { IconRocket, IconDashboard } from "/node_modules/.vite/deps/@tabler_icons-react.js?v=6ea3b3b8";
const definePluginUIModule = (module) => module;
var _jsxFileName = "/home/ahdg/code/plugin-style-ts/packages/hmr/tests/plugins/ui/index.tsx";
const __vite__cjsImport3_react_jsxDevRuntime = window.__PLUXEL_VENDORS__["react/jsx-dev-runtime"].default || window.__PLUXEL_VENDORS__["react/jsx-dev-runtime"]; const _jsxDEV = __vite__cjsImport3_react_jsxDevRuntime["jsxDEV"];
// ─────────────────────────────────────────────────────────
// Header 按钮组件
// ─────────────────────────────────────────────────────────
function HeaderButton({ ctx }) {
	return /* @__PURE__ */ _jsxDEV(Button, {
		variant: "light",
		size: "xs",
		leftSection: /* @__PURE__ */ _jsxDEV(IconRocket, { size: 14 }, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 19,
			columnNumber: 17
		}, this),
		color: "grape",
		children: "PluginWithUI"
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 16,
		columnNumber: 3
	}, this);
}
// ─────────────────────────────────────────────────────────
// 自定义 Tab 内容
// ─────────────────────────────────────────────────────────
function CustomTab({ ctx }) {
	return /* @__PURE__ */ _jsxDEV(Stack, {
		gap: "md",
		children: [
			/* @__PURE__ */ _jsxDEV(Text, {
				size: "lg",
				fw: 600,
				children: "自定义配置面板"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 33,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ _jsxDEV(Text, {
				c: "dimmed",
				children: "这是由 PluginWithUI 插件注入的自定义 Tab 内容。 你可以在这里添加任何自定义的配置界面。"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 36,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ _jsxDEV(Paper, {
				withBorder: true,
				p: "md",
				radius: "md",
				children: /* @__PURE__ */ _jsxDEV(Group, {
					justify: "space-between",
					children: [/* @__PURE__ */ _jsxDEV(Text, { children: "当前插件" }, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 42,
						columnNumber: 6
					}, this), /* @__PURE__ */ _jsxDEV(Badge, {
						color: "grape",
						children: ctx.pluginName
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 43,
						columnNumber: 6
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 41,
					columnNumber: 5
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 40,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 32,
		columnNumber: 3
	}, this);
}
// ─────────────────────────────────────────────────────────
// 插件信息卡片
// ─────────────────────────────────────────────────────────
function InfoCard({ ctx }) {
	return /* @__PURE__ */ _jsxDEV(Paper, {
		withBorder: true,
		p: "sm",
		radius: "md",
		bg: "grape.0",
		children: /* @__PURE__ */ _jsxDEV(Stack, {
			gap: "xs",
			children: [/* @__PURE__ */ _jsxDEV(Group, {
				gap: "xs",
				children: [/* @__PURE__ */ _jsxDEV(IconRocket, { size: 16 }, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 58,
					columnNumber: 6
				}, this), /* @__PURE__ */ _jsxDEV(Text, {
					size: "sm",
					fw: 500,
					children: "PluginWithUI 状态"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 59,
					columnNumber: 6
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 57,
				columnNumber: 5
			}, this), /* @__PURE__ */ _jsxDEV(Text, {
				size: "xs",
				c: "dimmed",
				children: "插件正在运行中，提供额外的 UI 扩展功能。"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 63,
				columnNumber: 5
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 56,
			columnNumber: 4
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 55,
		columnNumber: 3
	}, this);
}
// ─────────────────────────────────────────────────────────
// Dashboard 页面
// ─────────────────────────────────────────────────────────
function Dashboard() {
	return /* @__PURE__ */ _jsxDEV(Stack, {
		gap: "lg",
		p: "lg",
		children: [/* @__PURE__ */ _jsxDEV(Group, {
			gap: "sm",
			children: [/* @__PURE__ */ _jsxDEV(IconDashboard, { size: 24 }, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 78,
				columnNumber: 5
			}, this), /* @__PURE__ */ _jsxDEV(Text, {
				size: "xl",
				fw: 700,
				children: "PluginWithUI Dashboard"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 79,
				columnNumber: 5
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 77,
			columnNumber: 4
		}, this), /* @__PURE__ */ _jsxDEV(Paper, {
			withBorder: true,
			p: "lg",
			radius: "md",
			children: /* @__PURE__ */ _jsxDEV(Stack, {
				gap: "md",
				children: [/* @__PURE__ */ _jsxDEV(Text, { children: "这是一个由插件注入的独立页面。 通过路由扩展，插件可以添加完整的页面到应用中。" }, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 86,
					columnNumber: 6
				}, this), /* @__PURE__ */ _jsxDEV(Text, {
					c: "dimmed",
					size: "sm",
					children: "路径: /ext/PluginWithUI/dashboard"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 90,
					columnNumber: 6
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 85,
				columnNumber: 5
			}, this)
		}, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 84,
			columnNumber: 4
		}, this)]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 76,
		columnNumber: 3
	}, this);
}
// ─────────────────────────────────────────────────────────
// 模块导出
// ─────────────────────────────────────────────────────────
const module = definePluginUIModule({
	extensions: [
		{
			point: "header:actions",
			meta: { priority: 100 },
			Component: HeaderButton
		},
		{
			point: "plugin:tabs",
			meta: {
				priority: 10,
				label: "自定义面板",
				id: "PluginWithUI:plugin:tabs"
			},
			when: (ctx) => ctx.pluginName === "PluginWithUI",
			Component: CustomTab
		},
		{
			point: "plugin:info",
			meta: {
				priority: 5,
				requireRunning: true
			},
			when: (ctx) => ctx.pluginName === "PluginWithUI" && ctx.isPluginRunning === true,
			Component: InfoCard
		}
	],
	routes: [{
		definition: {
			path: "/dashboard",
			title: "PluginWithUI Dashboard",
			icon: /* @__PURE__ */ _jsxDEV(IconDashboard, {
				size: 18,
				stroke: 1.7
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 131,
				columnNumber: 11
			}, this),
			addToNav: true,
			navPriority: 50
		},
		Component: Dashboard
	}],
	setup() {
		console.log("[PluginWithUI] UI module loaded");
	}
});
export const { extensions, routes, setup } = module;
export default module;
