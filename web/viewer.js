import path from 'path'; 


function request(path, options) 
{
  const url = `/api/v1/${path}`;
  const token = process.env.API_KEY;
  const header = {"Authorization" : `Bearer ${token}`};
  fetch(url, {method: "GET", headers: header, options}).then(response => response.json().then(console.log)).catch(console.error); 
}

// render PDF and image in page
export async function render(id)
{
    const url = request(`/documents/${id}`, null);
    const response = await fetch(url, {method: "GET"});
    const task = await response.json();
  
}
