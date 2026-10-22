import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './auth.jsx';
import App from './App.jsx';
import MobileApp from './components/MobileApp.jsx';
import useLayout from './lib/layout.js';
import PackingList from './components/PackingList.jsx';
import './styles.css';

// A report opened in its own tab (?packing=<jobId>) renders on its own,
// without the app shell, so it prints as a clean A4 page.
const packingJob = new URLSearchParams(window.location.search).get('packing');
if (packingJob) document.body.classList.add('is-report');

// Phones get the field layout, everything else the planning layout; each
// can switch to the other (see lib/layout.js).
function Root() {
  const layout = useLayout();
  return layout.layout === 'mobile' ? <MobileApp layout={layout} /> : <App layout={layout} />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      {packingJob ? <PackingList jobId={packingJob} /> : <Root />}
    </AuthProvider>
  </React.StrictMode>
);
