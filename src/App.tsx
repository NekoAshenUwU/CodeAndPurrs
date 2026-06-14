import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { PurrChannelPage } from './pages/PurrChannelPage';
import { PawTrailPage } from './pages/PawTrailPage';
import { SwitchCorePage } from './pages/SwitchCorePage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/purr-channel" element={<PurrChannelPage />} />
      <Route path="/paw-trail" element={<PawTrailPage />} />
      <Route path="/switchcore" element={<SwitchCorePage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
