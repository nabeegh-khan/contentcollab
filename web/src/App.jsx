function App() {
  const api_up_down = fetch('http://localhost:3000/api/health'); // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch

  if (api_up_down.ok) {
    return "API up";
  }
  else {
    return "API down";
  }
}

export default App
