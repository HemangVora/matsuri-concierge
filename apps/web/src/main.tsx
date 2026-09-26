import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import Approve from './Approve.tsx';
import './styles.css';

const m = location.pathname.match(/^\/approve\/(.+)$/);
createRoot(document.getElementById('root')!).render(m ? <Approve id={m[1]} /> : <App />);
