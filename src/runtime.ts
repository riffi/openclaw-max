import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { Server } from "node:http";

type MaxRuntime = {
  note?: string;
  servers?: Map<string, Server>;
};

const { setRuntime: setMaxRuntime, getRuntime: getMaxRuntime } =
  createPluginRuntimeStore<MaxRuntime>("MAX runtime not initialized");

export { getMaxRuntime, setMaxRuntime };
