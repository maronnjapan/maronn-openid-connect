import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CodePage } from './CodePage';
import '../styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <CodePage />
  </StrictMode>,
);
