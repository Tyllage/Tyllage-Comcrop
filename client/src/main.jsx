import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { FarmProvider } from './context/FarmContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { DialogProvider } from './context/DialogContext.jsx';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <FarmProvider>
          <ToastProvider>
            <DialogProvider>
              <App />
            </DialogProvider>
          </ToastProvider>
        </FarmProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
