// sources used: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch, https://developer.mozilla.org/en-US/docs/Web/API/Response/status, https://stackoverflow.com/questions/69165892/how-to-throw-an-exception-with-a-status-code

function request(path, options) // https://jasonwatmore.com/fetch-add-bearer-token-authorization-header-to-http-request
{
  const url = "/api/v1/${path}";
  const token = process.env.API_KEY;
  const header = {'Authorization': 'Bearer ${token}'};
  fetch(url, {method: "GET", header, options}).then(response => response.json().then(console.log)).catch(console.error); // https://stackoverflow.com/questions/68824056/how-to-assign-bearer-token-to-authorization-header-in-javascript
}

export async function register()
{
  try
  {
    const url = request("auth/register", null);
    const response = await fetch(url, {method: "POST"});
    const task = await response.json();
    
    if (!response.ok)
    {
      throw new Error(`Response status: ${response.status}`);
    }
    else
    {
      console.log(task);
      return response.status;
    }
  }
    
  catch (err)
  {
    console.error(err.message);
  }
}

export async function login()
{
  try
  {
      const url = request("auth/login", null); 
      const response = await fetch(url, {method: "POST"});
      const result = await response.json(); 

      if (!response.ok)
      {
        throw new Error(`Response status: ${response.status}`);
      }

      return response.status, response.json(result);
  }
    
  catch (err) 
  {
    console.error(err.message);
  }

}


export async function uploadDocument(file, title)
{
  try
  {
    const file_size = file.size;
    const MAX_FILE_SIZE = 50 * 1024 * 1024;

    const path = require('path'); // https://www.tutorialspoint.com/nodejs/nodejs_path_extname_method.htm

    const extension = path.extname(file.name).toLowerCase();
    const acceptable_exts = [".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx", ".pptx", ".txt", ".md"];
      
    if (file_size > MAX_FILE_SIZE) // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file
    {
      const error = new Error("file must be <= 50 MB");
      error.code = 413;
      throw error;
    }

    if (!acceptable_exts.includes(extension))
    {
      const error = new Error("file type not allowed");
      error.code = 400;
      throw error;
    }

    const result = await fetch(file);
    const task = await result.json();
                                  
    console.log(task);
    return result.status;
  
  }
      
  catch (err) 
  {
    console.error(err.message);
  }  
}

export async function listDocuments({ limit, cursor })
{
  try
  {
    const lim = limit || 20;
    const url = request("documents", {lim, cursor});
    let items = [];

    if (lim > 100)
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, 100); // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/slice
    }
    else if (lim <= 0)
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, 1);
    }
    else
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, lim);
    }

    console.log(items);
    
    const nextCursor = cursor + 1; 
    
    return [items, nextCursor];
  }
   
  catch (err) 
  {
    console.error(err.message);
  }  
}

