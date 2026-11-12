/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createI18n, format, KeyValueStorage, LOCALE_STORAGE_KEY, pick } from '.';
import { en } from './en';
import { ru } from './ru';

const memory = (initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
};

describe('i18n', () => {
  test('English by default, Russian after setLocale, remembered in the storage', () => {
    const storage = memory();
    const i18n = createI18n({ storage });
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('screener.reset')).toBe('Reset');
    expect(i18n.setLocale('ru')).toBe('ru');
    expect(i18n.t('screener.reset')).toBe('Сбросить');
    expect(storage.data[LOCALE_STORAGE_KEY]).toBe('ru');
    expect(createI18n({ storage }).getLocale()).toBe('ru');
  });

  test('a missing key or locale falls back to English, an unknown key shows the key', () => {
    const i18n = createI18n({ storage: null, dictionaries: { en: { a: 'A', b: 'B {x}' }, ru: { a: 'А' } } });
    i18n.setLocale('ru');
    expect(i18n.t('a')).toBe('А');
    expect(i18n.t('b', { x: 1 })).toBe('B 1');
    expect(i18n.t('nope')).toBe('nope');
    expect(i18n.setLocale('de')).toBe('en');
    expect(createI18n({ storage: memory({ [LOCALE_STORAGE_KEY]: 'xx' }) }).getLocale()).toBe('en');
  });

  test('params, pick and a throwing storage', () => {
    expect(format('{count} of {total}', { count: 3, total: 10 })).toBe('3 of 10');
    expect(format('{missing} left', { count: 1 })).toBe('{missing} left');
    expect(pick({ en: 'Gold', ru: 'Золото' }, 'ru')).toBe('Золото');
    expect(pick({ en: 'Gold', ru: '' }, 'ru')).toBe('Gold');
    const holder = globalThis as unknown as { localStorage?: unknown };
    const before = holder.localStorage;
    holder.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    try {
      const i18n = createI18n();
      expect(i18n.getLocale()).toBe('en');
      expect(i18n.setLocale('ru')).toBe('ru');
    } finally { holder.localStorage = before; }
  });

  test('every Russian key exists in English and no text has an em dash', () => {
    expect(Object.keys(ru).filter((k) => !(k in en))).toEqual([]);
    expect(Object.values(en).concat(Object.values(ru)).filter((v) => /[\u2013\u2014]/.test(v))).toEqual([]);
  });
});
