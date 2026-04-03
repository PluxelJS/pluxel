import { i as __toCommonJS, t as __commonJSMin } from "./rolldown-runtime-C64D6zeW.js";
import "./virtual_mf-exposes_pluxel_ext_PluginWithUI_6jdrs0__remoteEntry_js-CVIpotUG.js";
import "./pluxel_ext_PluginWithUI_6jdrs0__H_A_I__hostAutoInit__H_A_I__-Cm0qJ30r.js";
import "./dist-Bkn8ZjXc.js";
import "./virtual_mf-REMOTE_ENTRY_ID_pluxel_ext_PluginWithUI_6jdrs0__remoteEntry_js-BD--uf2H.js";
import { a as __mf_174, c as __mf_193, d as __mf_348, f as __mf_349, i as __mf_159, l as __mf_326, n as __mf_125, o as __mf_178, p as __mf_353, r as __mf_126, s as __mf_181, t as __mf_112, u as __mf_347 } from "./pluxel_ext_PluginWithUI_6jdrs0__loadShare___mf_0_mantine_mf_1_core__loadShare__.mjs-1PSNKu5D.js";
import { i as __mf_4, n as __mf_2, r as __mf_3, t as __mf_0 } from "./pluxel_ext_PluginWithUI_6jdrs0__loadShare___mf_0_pluxel_mf_1_runtime_mf_1_web_mf_1_ui__loadShare__.mjs-R30-42y2.js";
import { a as init_pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__, i as __mf_40, n as __mf_18, o as pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare___exports, r as __mf_30, t as __mf_16 } from "./pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__.mjs-1UdM3_As.js";await init_pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__();
/**
* @license @tabler/icons-react v3.40.0 - MIT
*
* This source code is licensed under the MIT license.
* See the LICENSE file in the root directory of this source tree.
*/
var defaultAttributes = {
	outline: {
		xmlns: "http://www.w3.org/2000/svg",
		width: 24,
		height: 24,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round",
		strokeLinejoin: "round"
	},
	filled: {
		xmlns: "http://www.w3.org/2000/svg",
		width: 24,
		height: 24,
		viewBox: "0 0 24 24",
		fill: "currentColor",
		stroke: "none"
	}
};
await init_pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__();
var createReactComponent = (type, iconName, iconNamePascal, iconNode) => {
	const Component = __mf_18(({ color = "currentColor", size = 24, stroke = 2, title, className, children, ...rest }, ref) => __mf_16("svg", {
		ref,
		...defaultAttributes[type],
		width: size,
		height: size,
		className: [
			`tabler-icon`,
			`tabler-icon-${iconName}`,
			className
		].join(" "),
		...type === "filled" ? { fill: color } : {
			strokeWidth: stroke,
			stroke: color
		},
		...rest
	}, [
		title && __mf_16("title", { key: "svg-title" }, title),
		...iconNode.map(([tag, attrs]) => __mf_16(tag, attrs)),
		...Array.isArray(children) ? children : [children]
	]));
	Component.displayName = `${iconNamePascal}`;
	return Component;
};
var IconActivity = createReactComponent("outline", "activity", "Activity", [["path", {
	"d": "M3 12h4l3 8l4 -16l3 8h4",
	"key": "svg-0"
}]]);
var IconArrowLeft = createReactComponent("outline", "arrow-left", "ArrowLeft", [
	["path", {
		"d": "M5 12l14 0",
		"key": "svg-0"
	}],
	["path", {
		"d": "M5 12l6 6",
		"key": "svg-1"
	}],
	["path", {
		"d": "M5 12l6 -6",
		"key": "svg-2"
	}]
]);
var IconCirclePlus = createReactComponent("outline", "circle-plus", "CirclePlus", [
	["path", {
		"d": "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0",
		"key": "svg-0"
	}],
	["path", {
		"d": "M9 12h6",
		"key": "svg-1"
	}],
	["path", {
		"d": "M12 9v6",
		"key": "svg-2"
	}]
]);
var IconDashboard = createReactComponent("outline", "dashboard", "Dashboard", [
	["path", {
		"d": "M10 13a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
		"key": "svg-0"
	}],
	["path", {
		"d": "M13.45 11.55l2.05 -2.05",
		"key": "svg-1"
	}],
	["path", {
		"d": "M6.4 20a9 9 0 1 1 11.2 0l-11.2 0",
		"key": "svg-2"
	}]
]);
var IconExternalLink = createReactComponent("outline", "external-link", "ExternalLink", [
	["path", {
		"d": "M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6",
		"key": "svg-0"
	}],
	["path", {
		"d": "M11 13l9 -9",
		"key": "svg-1"
	}],
	["path", {
		"d": "M15 4h5v5",
		"key": "svg-2"
	}]
]);
var IconRestore = createReactComponent("outline", "restore", "Restore", [
	["path", {
		"d": "M3.06 13a9 9 0 1 0 .49 -4.087",
		"key": "svg-0"
	}],
	["path", {
		"d": "M3 4.001v5h5",
		"key": "svg-1"
	}],
	["path", {
		"d": "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"key": "svg-2"
	}]
]);
var IconRocket = createReactComponent("outline", "rocket", "Rocket", [
	["path", {
		"d": "M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3",
		"key": "svg-0"
	}],
	["path", {
		"d": "M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3",
		"key": "svg-1"
	}],
	["path", {
		"d": "M14 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"key": "svg-2"
	}]
]);
var IconServer = createReactComponent("outline", "server", "Server", [
	["path", {
		"d": "M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3",
		"key": "svg-0"
	}],
	["path", {
		"d": "M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2",
		"key": "svg-1"
	}],
	["path", {
		"d": "M7 8l0 .01",
		"key": "svg-2"
	}],
	["path", {
		"d": "M7 16l0 .01",
		"key": "svg-3"
	}]
]);
var IconWaveSine = createReactComponent("outline", "wave-sine", "WaveSine", [["path", {
	"d": "M21 12h-2c-.894 0 -1.662 -.857 -1.761 -2c-.296 -3.45 -.749 -6 -2.749 -6s-2.5 3.582 -2.5 8s-.5 8 -2.5 8s-2.452 -2.547 -2.749 -6c-.1 -1.147 -.867 -2 -1.763 -2h-2",
	"key": "svg-0"
}]]);
const plugin = __mf_3("PluginWithUI");
/**
* @license React
* react-jsx-dev-runtime.development.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_react_jsx_dev_runtime_development = /* @__PURE__ */ __commonJSMin(((exports) => {
	(function() {
		function getComponentNameFromType(type) {
			if (null == type) return null;
			if ("function" === typeof type) return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
			if ("string" === typeof type) return type;
			switch (type) {
				case REACT_FRAGMENT_TYPE: return "Fragment";
				case REACT_PROFILER_TYPE: return "Profiler";
				case REACT_STRICT_MODE_TYPE: return "StrictMode";
				case REACT_SUSPENSE_TYPE: return "Suspense";
				case REACT_SUSPENSE_LIST_TYPE: return "SuspenseList";
				case REACT_ACTIVITY_TYPE: return "Activity";
			}
			if ("object" === typeof type) switch ("number" === typeof type.tag && console.error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."), type.$$typeof) {
				case REACT_PORTAL_TYPE: return "Portal";
				case REACT_CONTEXT_TYPE: return type.displayName || "Context";
				case REACT_CONSUMER_TYPE: return (type._context.displayName || "Context") + ".Consumer";
				case REACT_FORWARD_REF_TYPE:
					var innerType = type.render;
					type = type.displayName;
					type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
					return type;
				case REACT_MEMO_TYPE: return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
				case REACT_LAZY_TYPE:
					innerType = type._payload;
					type = type._init;
					try {
						return getComponentNameFromType(type(innerType));
					} catch (x) {}
			}
			return null;
		}
		function testStringCoercion(value) {
			return "" + value;
		}
		function checkKeyStringCoercion(value) {
			try {
				testStringCoercion(value);
				var JSCompiler_inline_result = !1;
			} catch (e) {
				JSCompiler_inline_result = !0;
			}
			if (JSCompiler_inline_result) {
				JSCompiler_inline_result = console;
				var JSCompiler_temp_const = JSCompiler_inline_result.error;
				var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
				JSCompiler_temp_const.call(JSCompiler_inline_result, "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.", JSCompiler_inline_result$jscomp$0);
				return testStringCoercion(value);
			}
		}
		function getTaskName(type) {
			if (type === REACT_FRAGMENT_TYPE) return "<>";
			if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE) return "<...>";
			try {
				var name = getComponentNameFromType(type);
				return name ? "<" + name + ">" : "<...>";
			} catch (x) {
				return "<...>";
			}
		}
		function getOwner() {
			var dispatcher = ReactSharedInternals.A;
			return null === dispatcher ? null : dispatcher.getOwner();
		}
		function UnknownOwner() {
			return Error("react-stack-top-frame");
		}
		function hasValidKey(config) {
			if (hasOwnProperty.call(config, "key")) {
				var getter = Object.getOwnPropertyDescriptor(config, "key").get;
				if (getter && getter.isReactWarning) return !1;
			}
			return void 0 !== config.key;
		}
		function defineKeyPropWarningGetter(props, displayName) {
			function warnAboutAccessingKey() {
				specialPropKeyWarningShown || (specialPropKeyWarningShown = !0, console.error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)", displayName));
			}
			warnAboutAccessingKey.isReactWarning = !0;
			Object.defineProperty(props, "key", {
				get: warnAboutAccessingKey,
				configurable: !0
			});
		}
		function elementRefGetterWithDeprecationWarning() {
			var componentName = getComponentNameFromType(this.type);
			didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = !0, console.error("Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."));
			componentName = this.props.ref;
			return void 0 !== componentName ? componentName : null;
		}
		function ReactElement(type, key, props, owner, debugStack, debugTask) {
			var refProp = props.ref;
			type = {
				$$typeof: REACT_ELEMENT_TYPE,
				type,
				key,
				props,
				_owner: owner
			};
			null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
				enumerable: !1,
				get: elementRefGetterWithDeprecationWarning
			}) : Object.defineProperty(type, "ref", {
				enumerable: !1,
				value: null
			});
			type._store = {};
			Object.defineProperty(type._store, "validated", {
				configurable: !1,
				enumerable: !1,
				writable: !0,
				value: 0
			});
			Object.defineProperty(type, "_debugInfo", {
				configurable: !1,
				enumerable: !1,
				writable: !0,
				value: null
			});
			Object.defineProperty(type, "_debugStack", {
				configurable: !1,
				enumerable: !1,
				writable: !0,
				value: debugStack
			});
			Object.defineProperty(type, "_debugTask", {
				configurable: !1,
				enumerable: !1,
				writable: !0,
				value: debugTask
			});
			Object.freeze && (Object.freeze(type.props), Object.freeze(type));
			return type;
		}
		function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
			var children = config.children;
			if (void 0 !== children) if (isStaticChildren) if (isArrayImpl(children)) {
				for (isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++) validateChildKeys(children[isStaticChildren]);
				Object.freeze && Object.freeze(children);
			} else console.error("React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.");
			else validateChildKeys(children);
			if (hasOwnProperty.call(config, "key")) {
				children = getComponentNameFromType(type);
				var keys = Object.keys(config).filter(function(k) {
					return "key" !== k;
				});
				isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
				didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error("A props object containing a \"key\" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />", isStaticChildren, children, keys, children), didWarnAboutKeySpread[children + isStaticChildren] = !0);
			}
			children = null;
			void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
			hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
			if ("key" in config) {
				maybeKey = {};
				for (var propName in config) "key" !== propName && (maybeKey[propName] = config[propName]);
			} else maybeKey = config;
			children && defineKeyPropWarningGetter(maybeKey, "function" === typeof type ? type.displayName || type.name || "Unknown" : type);
			return ReactElement(type, children, maybeKey, getOwner(), debugStack, debugTask);
		}
		function validateChildKeys(node) {
			isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
		}
		function isValidElement(object) {
			return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
		}
		var React = (init_pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__(), __toCommonJS(pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare___exports)), REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
			return null;
		};
		React = { react_stack_bottom_frame: function(callStackForError) {
			return callStackForError();
		} };
		var specialPropKeyWarningShown;
		var didWarnAboutElementRef = {};
		var unknownOwnerDebugStack = React.react_stack_bottom_frame.bind(React, UnknownOwner)();
		var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
		var didWarnAboutKeySpread = {};
		exports.Fragment = REACT_FRAGMENT_TYPE;
		exports.jsxDEV = function(type, config, maybeKey, isStaticChildren) {
			var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
			return jsxDEVImpl(type, config, maybeKey, isStaticChildren, trackActualOwner ? Error("react-stack-top-frame") : unknownOwnerDebugStack, trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask);
		};
	})();
}));
var require_jsx_dev_runtime = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_react_jsx_dev_runtime_development();
}));
await init_pluxel_ext_PluginWithUI_6jdrs0__loadShare__react__loadShare__();
var import_jsx_dev_runtime = require_jsx_dev_runtime();
var _jsxFileName$1 = "/home/ahdg/code/pluxel-workspace/pluxel/packages/plugins/host/src/demo/PluginWithUI/ui/components.tsx";
function useLiveConnectionState(sse) {
	const [connected, setConnected] = __mf_40(false);
	__mf_30(() => {
		const offOpen = sse.onOpen(() => setConnected(true));
		const offError = sse.onError(() => setConnected(false));
		return () => {
			offOpen();
			offError();
		};
	}, [sse]);
	return connected;
}
function OverviewPanel() {
	const app = plugin.use();
	const status = app.db.useDocById("status", "status");
	const eventCount = app.db.useCount("events");
	const connected = useLiveConnectionState(app.transport.sse);
	const [tick, setTick] = __mf_40(null);
	const [error, setError] = __mf_40(null);
	__mf_30(() => {
		const off = app.sse.on((msg) => {
			const payload = msg.payload;
			if (payload.type === "tick") setTick(payload.now);
		}, "tick");
		return () => off();
	}, [app.sse]);
	const now = tick ?? Date.now();
	const uptimeSeconds = status ? Math.max(0, Math.floor((now - status.startedAt) / 1e3)) : 0;
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
		gap: "md",
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				justify: "space-between",
				align: "center",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
					gap: "xs",
					children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconServer, { size: 18 }, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 68,
						columnNumber: 6
					}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_353, {
						order: 4,
						children: "PluginWithUI 概览"
					}, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 69,
						columnNumber: 6
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName$1,
					lineNumber: 67,
					columnNumber: 5
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
					gap: "xs",
					children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_174, {
						variant: "light",
						color: connected ? "teal" : "gray",
						children: connected ? "SSE 已连接" : "SSE 未连接"
					}, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 72,
						columnNumber: 6
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 71,
					columnNumber: 5
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 66,
				columnNumber: 4
			}, this),
			error ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_159, {
				color: "red",
				title: "错误",
				children: error
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 79,
				columnNumber: 5
			}, this) : null,
			!status ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				gap: "xs",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_126, { size: "sm" }, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 86,
					columnNumber: 6
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
					size: "sm",
					c: "dimmed",
					children: "正在等待 signaldb 同步…"
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 87,
					columnNumber: 6
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 85,
				columnNumber: 5
			}, this) : null,
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_181, {
				withBorder: true,
				radius: "md",
				p: "md",
				children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
					gap: "xs",
					children: [
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							children: ["插件：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: app.pluginName }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 96,
								columnNumber: 10
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 95,
							columnNumber: 6
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							children: ["运行时长：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: [uptimeSeconds, "s"] }, void 0, true, {
								fileName: _jsxFileName$1,
								lineNumber: 99,
								columnNumber: 12
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 98,
							columnNumber: 6
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							children: ["计数器：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: (status === null || status === void 0 ? void 0 : status.counter) ?? 0 }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 102,
								columnNumber: 11
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 101,
							columnNumber: 6
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							children: ["事件数：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: eventCount }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 105,
								columnNumber: 11
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 104,
							columnNumber: 6
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							children: ["最近心跳：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: tick ? new Date(tick).toLocaleTimeString() : "—" }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 108,
								columnNumber: 12
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 107,
							columnNumber: 6
						}, this)
					]
				}, void 0, true, {
					fileName: _jsxFileName$1,
					lineNumber: 94,
					columnNumber: 5
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 93,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
				leftSection: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconCirclePlus, { size: 16 }, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 115,
					columnNumber: 19
				}, this),
				onClick: () => app.rpc.increment(1).then(() => setError(null)).catch((e) => setError(__mf_4(e, "无法执行 +1"))),
				children: "+1"
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 114,
				columnNumber: 5
			}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
				variant: "light",
				leftSection: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconRestore, { size: 16 }, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 127,
					columnNumber: 19
				}, this),
				onClick: () => app.rpc.resetCounter().then(() => setError(null)).catch((e) => setError(__mf_4(e, "无法重置计数器"))),
				children: "重置"
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 125,
				columnNumber: 5
			}, this)] }, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 113,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 65,
		columnNumber: 3
	}, this);
}
function EventsPanel() {
	const app = plugin.use();
	const eventsCollection = app.db.collection("events");
	const events = eventsCollection.useView();
	const recentEvents = eventsCollection.useLiveQuery((view) => view.find({}, {
		sort: { at: -1 },
		limit: 50
	}));
	const [error, setError] = __mf_40(null);
	const [text, setText] = __mf_40("");
	const addNote = async () => {
		const message = text.trim();
		if (!message) return;
		try {
			await app.rpc.addNote(message);
			setText("");
			setError(null);
		} catch (e) {
			setError(__mf_4(e, "无法添加事件"));
		}
	};
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
		gap: "md",
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				justify: "space-between",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
					gap: "xs",
					children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconActivity, { size: 18 }, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 168,
						columnNumber: 6
					}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_353, {
						order: 4,
						children: "事件流"
					}, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 169,
						columnNumber: 6
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName$1,
					lineNumber: 167,
					columnNumber: 5
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
					gap: "xs",
					children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
						variant: "light",
						color: "red",
						onClick: () => {
							app.rpc.clearEvents().catch(() => {});
						},
						children: "清空"
					}, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 172,
						columnNumber: 6
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 171,
					columnNumber: 5
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 166,
				columnNumber: 4
			}, this),
			error ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_159, {
				color: "red",
				title: "错误",
				children: error
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 185,
				columnNumber: 5
			}, this) : null,
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				align: "flex-end",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_349, {
					style: { flex: 1 },
					label: "发送一条 UI 事件",
					placeholder: "例如：用户点击了按钮 / RPC 返回 OK …",
					value: text,
					onChange: (e) => setText(e.currentTarget.value)
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 191,
					columnNumber: 5
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
					onClick: () => void addNote(),
					disabled: !text.trim(),
					children: "发送"
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 198,
					columnNumber: 5
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 190,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_181, {
				withBorder: true,
				radius: "md",
				p: 0,
				children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_112, {
					h: 320,
					type: "auto",
					scrollbarSize: 10,
					offsetScrollbars: true,
					children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
						gap: "xs",
						p: "sm",
						children: [
							!events.ready && recentEvents.length === 0 ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
								gap: "xs",
								children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_126, { size: "sm" }, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 208,
									columnNumber: 9
								}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
									size: "sm",
									c: "dimmed",
									children: "正在同步事件…"
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 209,
									columnNumber: 9
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName$1,
								lineNumber: 207,
								columnNumber: 8
							}, this) : null,
							events.ready && events.items.length === 0 ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
								size: "sm",
								c: "dimmed",
								children: "暂无事件，先发一条试试。"
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 215,
								columnNumber: 8
							}, this) : null,
							recentEvents.map((ev) => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_181, {
								withBorder: true,
								radius: "md",
								p: "sm",
								children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
									justify: "space-between",
									align: "flex-start",
									children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
										gap: 2,
										children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
											gap: "xs",
											children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_174, {
												size: "xs",
												variant: "light",
												children: ev.kind
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 224,
												columnNumber: 12
											}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
												size: "xs",
												c: "dimmed",
												children: new Date(ev.at).toLocaleTimeString()
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 227,
												columnNumber: 12
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 223,
											columnNumber: 11
										}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
											size: "sm",
											children: ev.message
										}, void 0, false, {
											fileName: _jsxFileName$1,
											lineNumber: 231,
											columnNumber: 11
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName$1,
										lineNumber: 222,
										columnNumber: 10
									}, this)
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 221,
									columnNumber: 9
								}, this)
							}, ev.id, false, {
								fileName: _jsxFileName$1,
								lineNumber: 220,
								columnNumber: 8
							}, this))
						]
					}, void 0, true, {
						fileName: _jsxFileName$1,
						lineNumber: 205,
						columnNumber: 6
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 204,
					columnNumber: 5
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 203,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 165,
		columnNumber: 3
	}, this);
}
function StreamsPanel() {
	const app = plugin.use();
	const connected = useLiveConnectionState(app.transport.sse);
	const [lines, setLines] = __mf_40([]);
	__mf_30(() => {
		const off = app.sse.onAny((msg) => {
			const payload = msg.payload;
			const text = typeof payload === "object" && payload && "type" in payload ? `${String(payload.type)}` : msg.event;
			setLines((prev) => [{
				key: `${Date.now()}-${prev.length}`,
				text
			}, ...prev].slice(0, 50));
		});
		return () => off();
	}, [app.sse]);
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
		gap: "md",
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				justify: "space-between",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
					gap: "xs",
					children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconWaveSine, { size: 18 }, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 264,
						columnNumber: 6
					}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_353, {
						order: 4,
						children: "SSE / Logs"
					}, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 265,
						columnNumber: 6
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName$1,
					lineNumber: 263,
					columnNumber: 5
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_174, {
					variant: "light",
					color: connected ? "teal" : "gray",
					children: connected ? "连接中" : "未连接"
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 267,
					columnNumber: 5
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 262,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
				size: "sm",
				c: "dimmed",
				children: "这里订阅本插件的 SSE 命名空间（`PluginWithUI`），展示最近收到的事件名（最多 50 条）。"
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 272,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_181, {
				withBorder: true,
				radius: "md",
				p: 0,
				children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_112, {
					h: 320,
					type: "auto",
					scrollbarSize: 10,
					offsetScrollbars: true,
					children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
						gap: 6,
						p: "sm",
						children: [lines.length === 0 ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "sm",
							c: "dimmed",
							children: "暂无日志，等待插件或宿主输出…"
						}, void 0, false, {
							fileName: _jsxFileName$1,
							lineNumber: 280,
							columnNumber: 8
						}, this) : null, lines.map((l) => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
							size: "xs",
							style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
							children: l.text
						}, l.key, false, {
							fileName: _jsxFileName$1,
							lineNumber: 285,
							columnNumber: 8
						}, this))]
					}, void 0, true, {
						fileName: _jsxFileName$1,
						lineNumber: 278,
						columnNumber: 6
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 277,
					columnNumber: 5
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 276,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 261,
		columnNumber: 3
	}, this);
}
function RoutePage({ frame = "shell" }) {
	const app = plugin.use();
	const standalone = frame === "standalone";
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
		gap: "md",
		style: standalone ? {
			minHeight: "100dvh",
			padding: 24
		} : void 0,
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				justify: "space-between",
				align: "center",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_353, {
					order: 3,
					children: standalone ? "插件 Standalone 页面" : "插件路由页面"
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 312,
					columnNumber: 5
				}, this), standalone ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
					variant: "light",
					size: "xs",
					leftSection: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconArrowLeft, { size: 14 }, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 317,
						columnNumber: 20
					}, this),
					component: "a",
					href: `/plugins/${encodeURIComponent(app.pluginName)}/dashboard`,
					children: "返回宿主壳"
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 314,
					columnNumber: 6
				}, this) : null]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 311,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
				size: "sm",
				c: "dimmed",
				children: ["这是插件提供的页面路由，用于演示 `routes` 能力。插件名：", /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: app.pluginName }, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 326,
					columnNumber: 38
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 325,
				columnNumber: 4
			}, this),
			standalone ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
				size: "sm",
				children: [
					"当前路由显式声明了 ",
					/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_193, { children: "frame: 'standalone'" }, void 0, false, {
						fileName: _jsxFileName$1,
						lineNumber: 330,
						columnNumber: 16
					}, this),
					"，因此不会挂宿主导航壳，但仍复用同一 套鉴权、主题、RPC/SSE 客户端与运行时上下文。"
				]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 329,
				columnNumber: 5
			}, this) : null,
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_348, {
				label: "任意输入（纯 UI 示例）",
				placeholder: "这里不调用后端，仅展示 UI 能力…",
				minRows: 4
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 334,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 310,
		columnNumber: 3
	}, this);
}
function StandaloneRoutePage() {
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(RoutePage, { frame: "standalone" }, void 0, false, {
		fileName: _jsxFileName$1,
		lineNumber: 344,
		columnNumber: 9
	}, this);
}
var _jsxFileName = "/home/ahdg/code/pluxel-workspace/pluxel/packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx";
function HeaderAction() {
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
		variant: "light",
		size: "xs",
		leftSection: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconRocket, { size: 14 }, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 15,
			columnNumber: 50
		}, this),
		color: "grape",
		children: "PluginWithUI"
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 15,
		columnNumber: 3
	}, this);
}
function PluginInfo() {
	const app = plugin.use();
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_326, {
		gap: "xs",
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
				fw: 600,
				children: "PluginWithUI"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 25,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_347, {
				size: "sm",
				c: "dimmed",
				children: "演示扩展 UI：Tab、Route、Standalone Route、SSE、RPC。"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 26,
				columnNumber: 4
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_125, {
				gap: "xs",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
					variant: "light",
					size: "xs",
					leftSection: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconExternalLink, { size: 14 }, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 33,
						columnNumber: 19
					}, this),
					component: "a",
					href: `/plugins/${encodeURIComponent(app.pluginName)}/dashboard`,
					children: "打开 Dashboard"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 30,
					columnNumber: 5
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(__mf_178, {
					variant: "subtle",
					size: "xs",
					component: "a",
					href: `/ext-standalone/${encodeURIComponent(app.pluginName)}/standalone`,
					children: "Standalone"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 39,
					columnNumber: 5
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 29,
				columnNumber: 4
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 24,
		columnNumber: 3
	}, this);
}
var ui_default = __mf_2({
	extensions: [
		{
			point: __mf_0.HeaderActions,
			id: "header-action",
			priority: 100,
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(HeaderAction, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 58,
				columnNumber: 18
			}, void 0)
		},
		{
			point: __mf_0.PluginTabs,
			id: "tab-overview",
			priority: 20,
			meta: { label: "概览" },
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(OverviewPanel, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 65,
				columnNumber: 18
			}, void 0)
		},
		{
			point: __mf_0.PluginTabs,
			id: "tab-events",
			priority: 19,
			meta: { label: "事件" },
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(EventsPanel, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 72,
				columnNumber: 18
			}, void 0)
		},
		{
			point: __mf_0.PluginTabs,
			id: "tab-streams",
			priority: 18,
			meta: { label: "Streams" },
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(StreamsPanel, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 79,
				columnNumber: 18
			}, void 0)
		},
		{
			point: __mf_0.PluginInfo,
			id: "plugin-info",
			priority: 10,
			requireRunning: true,
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(PluginInfo, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 86,
				columnNumber: 18
			}, void 0)
		}
	],
	routes: [
		{
			definition: {
				path: "/dashboard",
				title: "PluginWithUI Dashboard",
				icon: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(IconDashboard, {
					size: 18,
					stroke: 1.7
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 94,
					columnNumber: 11
				}, void 0),
				addToNav: true,
				navPriority: 50
			},
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(RoutePage, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 98,
				columnNumber: 18
			}, void 0)
		},
		{
			definition: {
				path: "/notes",
				title: "PluginWithUI Notes"
			},
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(RoutePage, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 105,
				columnNumber: 18
			}, void 0)
		},
		{
			definition: {
				path: "/standalone",
				title: "PluginWithUI Standalone",
				addToNav: true,
				navPriority: 40,
				frame: "standalone"
			},
			render: () => /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(StandaloneRoutePage, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 115,
				columnNumber: 18
			}, void 0)
		}
	]
});
export { ui_default as default };

//# sourceMappingURL=index-DZ4sP7Q8.js.map