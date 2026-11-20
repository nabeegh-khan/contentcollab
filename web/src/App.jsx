import { useEffect, useState } from 'react';

const LABELS = {
  loading: 'Checking service status',
  up: 'Service status: operational',
  down: 'Service status: unavailable',
};

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
    <p className="footer-line">
      <span
        className={`status-dot status-${status}`}
        role="img"
        aria-label={LABELS[status]}
      />
      <span>ContentCollab, ECE1779 Team 22</span>
    </p>
  );
}

export default App;
