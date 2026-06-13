import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { PurrChannelPage } from './pages/PurrChannelPage';
import { PawTrailPage } from './pages/PawTrailPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/purr-channel" element={<PurrChannelPage />} />
      <Route path="/paw-trail" element={<PawTrailPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
