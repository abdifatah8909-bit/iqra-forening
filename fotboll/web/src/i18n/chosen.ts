import { LOCALES, type Locale } from '@fotboll/shared';

/** Kept apart from ./index (which touches the DOM) so the session code can use it anywhere. */
const CHOSEN_KEY = 'locale_chosen';

export function rememberChosenLanguage(locale: Locale) {
  try {
    localStorage.setItem(CHOSEN_KEY, locale);
  } catch {
    // Private mode: the choice still applies until the page is closed.
  }
}

/** The language picked before signing in, if any; `consume` forgets it once applied to the account. */
export function chosenLanguage({ consume = false } = {}): Locale | null {
  try {
    const value = localStorage.getItem(CHOSEN_KEY);
    if (consume) localStorage.removeItem(CHOSEN_KEY);
    return value && (LOCALES as readonly string[]).includes(value) ? (value as Locale) : null;
  } catch {
    return null;
  }
}
