import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ensureStarterPackets } from './services/redPacket';
import './styles/global.css';

ensureStarterPackets(); // 这台设备第一次打开时,甜甜口袋两边各塞 500 起步

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
