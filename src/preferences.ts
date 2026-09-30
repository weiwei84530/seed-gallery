import type { Preferences } from './types';

const KEY = 'img-generator.key';
const PREFS = 'img-generator.preferences';
export const DEFAULT_BALANCE_LIMIT = 20;
export function readKey() {
  return localStorage.getItem(KEY) ?? '';
}
export function saveKey(key: string) {
  key ? localStorage.setItem(KEY, key) : localStorage.removeItem(KEY);
}
export function initialPreferences(saved: string | null, search: string): Preferences {
  try {
    const parsed = JSON.parse(saved ?? 'null');
    if (typeof parsed?.showMoney === 'boolean')
      return {
        showMoney: parsed.showMoney,
        chatSystemPrompt:
          typeof parsed.chatSystemPrompt === 'string'
            ? parsed.chatSystemPrompt.slice(0, 12000)
            : '',
        balanceLimit:
          typeof parsed.balanceLimit === 'number' &&
          Number.isFinite(parsed.balanceLimit) &&
          parsed.balanceLimit > 0
            ? parsed.balanceLimit
            : DEFAULT_BALANCE_LIMIT,
      };
  } catch {
    /* Use a safe default when an old preference is unreadable. */
  }
  return {
    showMoney: new URLSearchParams(search).get('costs') !== 'hidden',
    balanceLimit: DEFAULT_BALANCE_LIMIT,
  };
}
export function readPreferences() {
  return initialPreferences(localStorage.getItem(PREFS), location.search);
}
export function savePreferences(p: Preferences) {
  localStorage.setItem(PREFS, JSON.stringify(p));
}
export function resetPreferences() {
  localStorage.removeItem(PREFS);
}
