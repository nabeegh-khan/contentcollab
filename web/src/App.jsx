import { useEffect, useState } from 'react';

function App() {
  const [status, setStatus] = useState('loading');
  
  useEffect(() => {
    let ignore = false;
 
    fetch('/health')
      .then((res) => res.json())
      .then((body) => {
        if (!ignore) setStatus(body.status === 'ok' ? 'up' : 'down');
      })
      .catch(() => {
        if (!ignore) setStatus('down');
      });
 
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <p>
      {status === 'loading'
        ? 'Checking...'
        : status === 'up'
          ? 'API up'
          : 'API down'}
    </p>
  );
}

export default App
