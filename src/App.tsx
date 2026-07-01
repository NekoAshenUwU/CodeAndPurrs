import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { PurrChannelPage } from './pages/PurrChannelPage';
import { PawTrailPage } from './pages/PawTrailPage';
import { LocationPage } from './pages/LocationPage';
import { SwitchCorePage } from './pages/SwitchCorePage';
import { MemeBoxPage } from './pages/MemeBoxPage';
import { MemoryJarPage } from './pages/MemoryJarPage';
import { SweetiePocketPage } from './pages/SweetiePocketPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/purr-channel" element={<PurrChannelPage />} />
      <Route path="/paw-trail" element={<PawTrailPage />} />
      <Route path="/lang-na-le" element={<LocationPage />} />
      <Route path="/switchcore" element={<SwitchCorePage />} />
      <Route path="/meme-box" element={<MemeBoxPage />} />
      <Route path="/memory-jar" element={<MemoryJarPage />} />
      <Route path="/sweetie-pocket" element={<SweetiePocketPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
