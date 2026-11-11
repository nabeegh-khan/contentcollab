import { useEffect, useState } from 'react';

function App() {
  const [status, setStatus] = useState('loading');
  
  useEffect(() => {
    let ignore = false;
    fetch('/health')
      .then((res) => { if (!ignore) setStatus(res.ok ? 'up' : 'down'); })
      .catch(() => { if (!ignore) setStatus('down'); });
    return () => { ignore = true; };
  }, []);

export default App
