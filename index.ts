import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { maxPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime.js";

export { maxPlugin } from "./src/channel.js";
export { setMaxRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "max",
  name: "MAX",
  description: "VK MAX messenger channel plugin",
  plugin: maxPlugin,
  setRuntime: setMaxRuntime,
});

