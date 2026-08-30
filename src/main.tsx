import { createRoot } from 'react-dom/client';
import App from './App';
import HardwareOutputLogView from './ui/views/HardwareOutputLogView';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root-element-not-found');

const view = new URLSearchParams(window.location.search).get('view');

createRoot(rootElement).render(view === 'hardware-output-log' ? <HardwareOutputLogView /> : <App />);
