import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './auth.jsx';
import App from './App.jsx';
import PackingList from './components/PackingList.jsx';
import './styles.css';

// A report opened in its own tab (?packing=<jobId>) renders on its own,
// without the app shell, so it prints as a clean A4 page.
const packingJob = new URLSearchParams(window.location.search).get('packing');
if (packingJob) document.body.classList.add('is-report');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      {packingJob ? <PackingList jobId={packingJob} /> : <App />}
    </AuthProvider>
  </React.StrictMode>
);
