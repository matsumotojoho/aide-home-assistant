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
import { macExecute, macStatus } from './mac.js';
import {
  calendarRead,
  calendarCreate,
  calendarUpdate,
  calendarDelete,
  mailSearch,
  mailRead,
  mailDraft,
  mailSend,
  contactsSearch,
  messagePrepare,
  messageSend,
  webSearch,
} from './stubs.js';

export { ToolRegistry } from './registry.js';
export type { ToolContext, ToolDef, ExecuteOptions } from './registry.js';

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const all = [
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
    calendarRead,
    calendarCreate,
    calendarUpdate,
    calendarDelete,
    mailSearch,
    mailRead,
    mailDraft,
    mailSend,
    contactsSearch,
    messagePrepare,
    messageSend,
    webSearch,
    webFetch,
    macExecute,
    macStatus,
    notificationSend,
    systemGetContext,
  ];
  for (const t of all) registry.register(t);
  return registry;
}
