import { propertiesMarkdown } from '../properties';
import type { ReportKind } from '../shell/panels';
import { SHELL_CSS } from '../shell/style';

import { isPropertiesAction, isPropertiesView } from './protocol';
import type { PropertiesAction } from './protocol';
import type { PropertiesData, PropertiesView } from './model';

// The rules of the metadata table: values are paths and settings that may be long, so they wrap.
const PROPERTIES_CSS = `${SHELL_CSS}
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
td.value { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; }
`;

export const propertiesKind: ReportKind<PropertiesData, PropertiesAction, PropertiesView> = {
  viewType: 'aantje.properties',
  css: PROPERTIES_CSS,
  message: (data) => ({ type: 'properties', data }),
  isAction: isPropertiesAction,
  isView: isPropertiesView,
  toMarkdown: (data, view) => propertiesMarkdown(data.connection, data.properties, view?.filter),
};
