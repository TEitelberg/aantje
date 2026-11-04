// Everything a spec needs, in one import: import { expect, openWorkbench, runCommand } from '../lib/index.mjs';
export { imageSha256, maskImageOf } from './assets.mjs';
export { readClipboard, writeClipboard } from './clipboard.mjs';
export { activeTab, diffEditorTexts, editorText, focusEditor, setEditorText } from './editor.mjs';
export { eventually, expect } from './expect.mjs';
export { extensionDetails, openExtensionDetails } from './extensions.mjs';
export {
  answerDialog,
  dismissNotifications,
  notificationButtons,
  notificationTexts,
  pressNotificationButton,
  waitForNotification,
} from './notifications.mjs';
export { cancelPrompt, input, pick, quickInput, runCommand } from './quick-input.mjs';
export { around } from './screenshots.mjs';
export {
  EXTENSIONS,
  FIXTURES,
  MACHINE_SETTINGS,
  PROJECT,
  USER_DATA,
  USER_SETTINGS,
  parseJsonc,
} from './server.mjs';
export {
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  contextMenuItems,
  disabledSubmenuItems,
  expandNode,
  hoverText,
  outline,
  readTree,
  scrollToRow,
  submenuItems,
  treeRow,
} from './tree.mjs';
export {
  activityBar,
  activityBarTab,
  openView,
  openWorkbench,
  outputChannels,
  panel,
  setColorTheme,
  showOutputChannel,
  sidebar,
  statusBarItem,
  statusBarItems,
} from './workbench.mjs';
