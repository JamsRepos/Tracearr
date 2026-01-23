import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// ============================================================================
// English Translations (Base Language)
// ============================================================================
import commonEn from './locales/en/common.json' with { type: 'json' };
import notificationsEn from './locales/en/notifications.json' with { type: 'json' };
import settingsEn from './locales/en/settings.json' with { type: 'json' };
import navEn from './locales/en/nav.json' with { type: 'json' };
import pagesEn from './locales/en/pages.json' with { type: 'json' };
import mobileEn from './locales/en/mobile.json' with { type: 'json' };

// ============================================================================
// German Translations
// ============================================================================
import commonDe from './locales/de/common.json' with { type: 'json' };
import notificationsDe from './locales/de/notifications.json' with { type: 'json' };
import settingsDe from './locales/de/settings.json' with { type: 'json' };
import navDe from './locales/de/nav.json' with { type: 'json' };
import pagesDe from './locales/de/pages.json' with { type: 'json' };
import mobileDe from './locales/de/mobile.json' with { type: 'json' };

// ============================================================================
// Portuguese Translations
// ============================================================================
import commonPt from './locales/pt/common.json' with { type: 'json' };
import notificationsPt from './locales/pt/notifications.json' with { type: 'json' };
import settingsPt from './locales/pt/settings.json' with { type: 'json' };
import navPt from './locales/pt/nav.json' with { type: 'json' };
import pagesPt from './locales/pt/pages.json' with { type: 'json' };
import mobilePt from './locales/pt/mobile.json' with { type: 'json' };

// ============================================================================
// Add New Languages Here
// ============================================================================
// To add a new language (e.g., Spanish):
// 1. Create folder: src/locales/es/
// 2. Copy all JSON files from src/locales/en/ to src/locales/es/
// 3. Translate the values in each JSON file
// 4. Import the files below:
//    import commonEs from './locales/es/common.json' with { type: 'json' };
//    import notificationsEs from './locales/es/notifications.json' with { type: 'json' };
//    ... (all namespaces)
// 5. Add to resources object below:
//    es: { common: commonEs, notifications: notificationsEs, ... }
// 6. Add to supportedLanguages array
// 7. Add display name in src/language.ts languageNames object
// ============================================================================

export const defaultNS = 'common';
export const namespaces = [
  'common',
  'notifications',
  'settings',
  'nav',
  'pages',
  'mobile',
] as const;
export type Namespace = (typeof namespaces)[number];

export const resources = {
  en: {
    common: commonEn,
    notifications: notificationsEn,
    settings: settingsEn,
    nav: navEn,
    pages: pagesEn,
    mobile: mobileEn,
  },
  de: {
    common: commonDe,
    notifications: notificationsDe,
    settings: settingsDe,
    nav: navDe,
    pages: pagesDe,
    mobile: mobileDe,
  },
  pt: {
    common: commonPt,
    notifications: notificationsPt,
    settings: settingsPt,
    nav: navPt,
    pages: pagesPt,
    mobile: mobilePt,
  },
  // Add new languages here:
  // es: {
  //   common: commonEs,
  //   notifications: notificationsEs,
  //   settings: settingsEs,
  //   nav: navEs,
  //   pages: pagesEs,
  //   mobile: mobileEs,
  // },
} as const;

export const supportedLanguages = Object.keys(resources) as (keyof typeof resources)[];
export type SupportedLanguage = keyof typeof resources;

const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

export const defaultI18nConfig = {
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  ns: namespaces,
  resources,
  interpolation: {
    escapeValue: false, // React already escapes values
  },
  saveMissing: isDev,
  missingKeyHandler: isDev
    ? (_lngs: readonly string[], ns: string, key: string) => {
        console.warn(`[i18n] Missing translation: ${ns}:${key}`);
      }
    : undefined,
  // Returning the key is better than empty string for debugging
  returnNull: false,
  returnEmptyString: false,
} as const;

// Prevents race conditions when initI18n is called concurrently
let initPromise: Promise<typeof i18n> | null = null;

/**
 * Initialize i18next. Call once at app startup before rendering.
 * Safe to call concurrently - multiple calls share the same initialization.
 */
export interface InitI18nOptions {
  lng?: SupportedLanguage;
}

export async function initI18n(options?: InitI18nOptions): Promise<typeof i18n> {
  if (i18n.isInitialized) {
    return i18n;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = i18n
    .use(initReactI18next)
    .init({
      ...defaultI18nConfig,
      ...options,
    })
    .then(() => {
      initPromise = null;
      return i18n;
    })
    .catch((error: unknown) => {
      initPromise = null;
      throw error;
    });

  return initPromise;
}

export { i18n };
