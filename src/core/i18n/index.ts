/// <reference lib="esnext" />
/**
 * i18n of the core: t(key, params) over the `en` and `ru` dictionaries, English fallback for a missing key or locale.
 * No DOM: the locale is persisted through an injected storage; the default wraps globalThis.localStorage in try/catch,
 * so a private window, blocked storage or a test without a DOM just keeps the locale in memory
 */
import { en } from './en';
import { ru } from './ru';

export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export type Params = Record<string, string | number>;
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export type Dictionaries = Record<string, Record<string, string>>;

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'stocks-locale';
export const DICTIONARIES: Dictionaries = { en, ru };

export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'ru';

/** localStorage when the runtime has it, every call guarded (it throws in some private modes); null without one */
export function browserStorage(): KeyValueStorage | null {
  const holder = globalThis as unknown as { localStorage?: KeyValueStorage };
  let store: KeyValueStorage | undefined;
  try { store = holder.localStorage; } catch { return null; }
  if (!store) return null;
  const safe = store;
  return {
    getItem: (key) => { try { return safe.getItem(key); } catch { return null; } },
    setItem: (key, value) => { try { safe.setItem(key, value); } catch { /* storage full or blocked: keep it in memory */ } },
  };
}

/** `{name}` placeholders replaced by params; an unknown placeholder stays as written so a missing param is visible */
export function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

export type I18n = { t(key: string, params?: Params): string; getLocale(): Locale; setLocale(locale: string): Locale };

export function createI18n(options: { storage?: KeyValueStorage | null; dictionaries?: Dictionaries } = {}): I18n {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const dictionaries = options.dictionaries ?? DICTIONARIES;
  const saved = storage ? storage.getItem(LOCALE_STORAGE_KEY) : null;
  let locale: Locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
  return {
    t(key, params) {
      const own = dictionaries[locale]?.[key];
      const text = own ?? dictionaries[DEFAULT_LOCALE]?.[key] ?? key;
      return format(text, params);
    },
    getLocale: () => locale,
    setLocale(next) {
      locale = isLocale(next) ? next : DEFAULT_LOCALE;
      if (storage) storage.setItem(LOCALE_STORAGE_KEY, locale);
      return locale;
    },
  };
}

const shared = createI18n();
export const t = (key: string, params?: Params): string => shared.t(key, params);
export const getLocale = (): Locale => shared.getLocale();
export const setLocale = (locale: string): Locale => shared.setLocale(locale);

/** Picks the text of a `{ en, ru }` pair (registry and preset texts) with the same English fallback */
export const pick = (text: { en: string; ru?: string } | undefined, locale: Locale = getLocale()): string =>
  !text ? '' : (locale === 'ru' && text.ru ? text.ru : text.en);
