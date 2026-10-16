import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './i18n';
import './styles.css';
import { App } from './App';
import { restoreSession } from './session';

import { DEMO } from './demo';

if (!DEMO) registerSW({ immediate: true });

void restoreSession().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
