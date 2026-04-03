var __mfPromiseGlobalKey = "__mf_init____mf__virtual/pluxel_ext_PluginWithUI_6jdrs0__mf_v__runtimeInit__mf_v__.js__";
var __mfPromiseState = globalThis[__mfPromiseGlobalKey];
if (!__mfPromiseState) {
	let initResolve, initReject;
	const initPromise = new Promise((re, rj) => {
		initResolve = re;
		initReject = rj;
	});
	__mfPromiseState = globalThis[__mfPromiseGlobalKey] = {
		initPromise,
		initResolve,
		initReject
	};
	if (typeof window === "undefined") initResolve({
		loadRemote: function() {
			return Promise.resolve(void 0);
		},
		loadShare: function() {
			return Promise.resolve(void 0);
		}
	});
}
var exportModule = await __mfPromiseState.initPromise.then((runtime) => runtime.loadShare("@pluxel/runtime/web/ui", { customShareInfo: { shareConfig: {
	singleton: true,
	strictVersion: false,
	requiredVersion: "^0.3.0"
} } })).then((factory) => typeof factory === "function" ? factory() : factory);
exportModule.__esModule && exportModule.default;
var { ExtensionPoints: __mf_0, defineInteractionContract: __mf_1, definePluginUIModule: __mf_2, pluginUi: __mf_3, rpcErrorMessage: __mf_4 } = exportModule;
export { __mf_4 as i, __mf_2 as n, __mf_3 as r, __mf_0 as t };

//# sourceMappingURL=pluxel_ext_PluginWithUI_6jdrs0__loadShare___mf_0_pluxel_mf_1_runtime_mf_1_web_mf_1_ui__loadShare__.mjs-R30-42y2.js.map