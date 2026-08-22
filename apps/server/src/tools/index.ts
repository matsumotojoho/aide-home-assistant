import { ToolRegistry } from './registry.js';
import { homeGetState, homeExecute } from './home.js';
import {
  memorySearch,
  memoryWrite,
  memoryUpdate,
  memoryDelete,
  tasksCreate,
  tasksUpdate,
  tasksCancel,
  tasksList,
  notificationSend,
  systemGetContext,
  webFetch,
} from './core.js';
import { macExecute, macStatus, browserOpen, codexRun } from './mac.js';
import { messagePrepare, messageSend, webSearch } from './stubs.js';
import { createGoogleTools } from '../google/tools.js';

export { ToolRegistry } from './registry.js';
export type { ToolContext, ToolDef, ExecuteOptions } from './registry.js';

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const all = [
    ...createGoogleTools((ctx) => ctx.googleAuth),
    homeGetState,
    homeExecute,
    memorySearch,
    memoryWrite,
    memoryUpdate,
    memoryDelete,
    tasksCreate,
    tasksUpdate,
    tasksCancel,
    tasksList,
    messagePrepare,
    messageSend,
    webSearch,
    webFetch,
    macExecute,
    macStatus,
    browserOpen,
    codexRun,
    notificationSend,
    systemGetContext,
  ];
  for (const t of all) registry.register(t);
  return registry;
}
