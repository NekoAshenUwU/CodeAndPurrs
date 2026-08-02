import { useNavigate } from 'react-router-dom';
import { ExportPod } from '../components/ExportPod';

export function ExportPodPage() {
  const navigate = useNavigate();
  return (
    <main className="export-pod-page">
      <ExportPod onClose={() => navigate('/')} />
    </main>
  );
}
