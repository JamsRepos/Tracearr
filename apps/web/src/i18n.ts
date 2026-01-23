import { initI18n, type SupportedLanguage, supportedLanguages } from '@tracearr/translations';

// Initialize i18n with browser language detection
const userLanguage = navigator.language.split('-')[0] as SupportedLanguage;
const language: SupportedLanguage = supportedLanguages.includes(userLanguage) ? userLanguage : 'en';

void initI18n({ lng: language });

export { i18n } from '@tracearr/translations';
