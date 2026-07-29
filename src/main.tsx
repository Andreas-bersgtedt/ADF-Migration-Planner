import React from 'react';
import ReactDOM from 'react-dom/client';
import { EventType, PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import App from './App';
import { msalConfig } from './auth/msalConfig';
import './styles.css';

const msalInstance = new PublicClientApplication(msalConfig);

msalInstance.addEventCallback((event) => {
  if (event.eventType === EventType.LOGIN_SUCCESS && event.payload && 'account' in event.payload) {
    msalInstance.setActiveAccount(event.payload.account ?? null);
  }
});

msalInstance.initialize().then(async () => {
  const redirectResponse = await msalInstance.handleRedirectPromise();

  if (redirectResponse?.account) {
    msalInstance.setActiveAccount(redirectResponse.account);
  } else if (!msalInstance.getActiveAccount() && msalInstance.getAllAccounts().length > 0) {
    msalInstance.setActiveAccount(msalInstance.getAllAccounts()[0]);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>,
  );
});
