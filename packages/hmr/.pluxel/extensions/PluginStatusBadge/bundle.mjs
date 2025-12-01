// packages/hmr/tests/plugins/ui/StatusBadge.tsx
// 简单的状态徽章组件
const {Badge, Tooltip} = window.__PLUXEL_VENDORS__["@mantine/core"];
import { IconActivity } from "/node_modules/.vite/deps/@tabler_icons-react.js?v=479d94cc";
import { definePluginUIModule } from "/src/web.ts";
var _jsxFileName = "/home/ahdg/code/plugin-style-ts/packages/hmr/tests/plugins/ui/StatusBadge.tsx";
const __vite__cjsImport3_react_jsxDevRuntime = window.__PLUXEL_VENDORS__["react/jsx-dev-runtime"].default || window.__PLUXEL_VENDORS__["react/jsx-dev-runtime"]; const _jsxDEV = __vite__cjsImport3_react_jsxDevRuntime["jsxDEV"];
function StatusBadge({ ctx }) {
	return /* @__PURE__ */ _jsxDEV(Tooltip, {
		label: "PluginStatusBadge 运行中",
		children: /* @__PURE__ */ _jsxDEV(Badge, {
			variant: "dot",
			color: "teal",
			size: "sm",
			leftSection: /* @__PURE__ */ _jsxDEV(IconActivity, { size: 12 }, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 18,
				columnNumber: 18
			}, this),
			children: "Active"
		}, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 14,
			columnNumber: 4
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 13,
		columnNumber: 3
	}, this);
}
const module = definePluginUIModule({
	extensions: [{
		point: "header:actions",
		meta: { priority: 50 },
		Component: StatusBadge
	}],
	setup() {
		console.log("[PluginStatusBadge] UI loaded");
	}
});
export const { extensions, setup } = module;
export default module;
