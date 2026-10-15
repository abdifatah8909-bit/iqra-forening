import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LOCALES, type Locale } from '@fotboll/shared';
import en from './en.json';
import so from './so.json';
import ar from './ar.json';
import { rememberChosenLanguage } from './chosen';

export { chosenLanguage } from './chosen';

export const LANGUAGE_NAMES: Record<Locale, string> = {
  so: 'Soomaali',
  en: 'English',
  ar: 'العربية',
};

const RTL: Locale[] = ['ar'];

function detect(): Locale {
  const nav = navigator.language.slice(0, 2);
  return (LOCALES as readonly string[]).includes(nav) ? (nav as Locale) : 'so';
}

/** Applies a language and the matching text direction to the whole document. */
export function setLanguage(locale: Locale) {
  void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL.includes(locale) ? 'rtl' : 'ltr';
  try {
    localStorage.setItem('locale', locale);
  } catch {
    // Private mode: the language just isn't remembered before sign-in.
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, so: { translation: so }, ar: { translation: ar } },
  lng: 'so',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/**
 * A language the person picked themselves before signing in (login screen,
 * public pages). It wins over the language saved on their account, which is
 * then updated, so picking English and signing in gives English.
 */
export function chooseLanguage(locale: Locale) {
  setLanguage(locale);
  rememberChosenLanguage(locale);
}

let initial: Locale = detect();
try {
  const saved = localStorage.getItem('locale');
  if (saved && (LOCALES as readonly string[]).includes(saved)) initial = saved as Locale;
} catch {
  // ignore
}
setLanguage(initial);

/**
 * Dates and times in the user's language. Arabic uses Western digits here,
 * which is what Somali-Arabic bilingual users usually expect for scores and times.
 */
export function formatDateTime(iso: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  const locale = i18n.language === 'ar' ? 'ar-u-nu-latn' : i18n.language;
  return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
}

export default i18n;

/** A calendar date (YYYY-MM-DD) without a time zone shift. */
export function formatDate(date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const locale = i18n.language === 'ar' ? 'ar-u-nu-latn' : i18n.language;
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
