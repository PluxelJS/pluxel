// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
import { Plugin, Optional } from "../core/PluginDecorator";
import { BasePlugin } from "../core/PluginBase";
import { PluginB } from "./PluginB";
import { PluginC } from "./PluginC";

@Plugin({ name: "PluginA", type: "event" })
export class PluginA extends BasePlugin {
  constructor(public pluginB: PluginB, @Optional public pluginC?: PluginC) {
    super();
  }

  init(): void {
    this.ctx.logger.info("PluginA initialized");
    // 使用必需依赖 PluginB
    this.pluginB.doSomething();
    // 可选依赖 PluginC 进行判断
    if (this.pluginC) {
      this.ctx.logger.info("PluginA using PluginC dependency");
    } else {
      this.ctx.logger.info("PluginA: PluginC dependency not injected");
    }
  }

  doSomething(): void {
    this.ctx.logger.info("PluginA doing something...");
  }
}
