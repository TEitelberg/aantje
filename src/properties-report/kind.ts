import type { ReportKind } from '../shell/panels';
import { propertiesMarkdown } from './markdown';
import type { PropertiesData, PropertiesView } from './model';
import { isPropertiesAction, isPropertiesView } from './protocol';
import type { PropertiesAction } from './protocol';
import { PROPERTIES_CSS } from './style';

export const propertiesKind: ReportKind<PropertiesData, PropertiesAction, PropertiesView> = {
  viewType: 'aantje.properties',
  css: PROPERTIES_CSS,
  message: (data) => ({ type: 'properties', data }),
  isAction: isPropertiesAction,
  isView: isPropertiesView,
  toMarkdown: (data, view) => propertiesMarkdown(data.connection, data.properties, view?.filter),
};
