import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { cleanupLegacyStarterPackets } from './services/redPacket';
import './styles/global.css';

cleanupLegacyStarterPackets(); // 清掉早期版本塞进账本的"开局本金"记录，本金现在改用底部宝箱单独展示

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
