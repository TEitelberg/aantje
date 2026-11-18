import type { ReportKind } from '../shell/panels';
import { isTemplateAction } from './protocol';
import type { TemplateAction } from './protocol';
import type { TemplatesData } from './search';
import { TEMPLATES_CSS } from './style';

/** What the extension keeps of the data of the page; the logo is added when it is sent. */
export type TemplatesPageData = Omit<TemplatesData, 'logo'>;

/** The Templates page. `logo` gives the webview URI of the logo, which only the panel knows once it exists. */
export function templatesKind(logo: () => string): ReportKind<TemplatesPageData, TemplateAction, never> {
  return {
    viewType: 'aantje.templates',
    css: TEMPLATES_CSS,
    message: (data) => ({ type: 'templates', data: { ...data, logo: logo() } }),
    isAction: isTemplateAction,
  };
}
