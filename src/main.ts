import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow-semi-condensed/700.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/400.css';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

window.addEventListener('error', (e) => { (window as any).__state = { ...(window as any).__state, error: String(e.message) }; });

if (params.get('debug') === 'view') {
  import('./debug/viewer').then((m) => m.runViewer(canvas)).catch((e) => { console.error(e); (window as any).__state = { error: String(e) }; });
} else {
  import('./core/App').then((m) => m.startApp(canvas)).catch((e) => { console.error(e); (window as any).__state = { error: String(e) }; });
}
