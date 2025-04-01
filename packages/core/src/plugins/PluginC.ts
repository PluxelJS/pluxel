// PluginC.ts
import { Plugin } from "../core/PluginDecorator";
import { BasePlugin } from "../core/PluginBase";

@Plugin({ name: "PluginC", type: "hook" })
export class PluginC extends BasePlugin {
  init(): void {
    this.ctx.logger.info("PluginC initialized");
  }
}
