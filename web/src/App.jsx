function App() {
  const api_up_down = useState('http://localhost:3000/api/health'); // https://react.dev/reference/react/useEffect, https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch

  if (api_up_down.ok) {
    return "API up";
  }
  else {
    return "API down";
  }
}

  useEffect(() => {
    const result = api_up_down.ok;
  };

export default App
