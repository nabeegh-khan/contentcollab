import Fs from 'fs/promises'; // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file

// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch, https://developer.mozilla.org/en-US/docs/Web/API/Response/status, https://stackoverflow.com/questions/69165892/how-to-throw-an-exception-with-a-status-code

function request(path, options)
{
  
}

export async function register()
{
  try
  {
    const url = "/auth/register";
    const response = await fetch(url, {method: "POST"});
    const task = await response.json();
    
    if (response.status === 409)
    {
      const error = new Error("email taken");
      throw error;
    }
    else
    {
      console.log(task);
      return response.status;
    }
  }
    
  catch (err)
  {
    err.code = 500; 
    throw err;
  }
}

export async function login()
{
  try
  {
      const url = "/auth/login"; 
      const response = await fetch(url, {method: "POST"});
      const result = await response.json(); 

      if (response.status === 401)
      {
        const error = new Error("wrong email or password");
        throw error;
      }

      return response.status, response.json(result);
  }
    
  catch (err) 
  {
    err.code = 500; 
    throw err;
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
    err.code = 500; 
    throw err;
  }  
}

export async function listDocuments({ limit, cursor })
{
  try
  {
    const lim = limit || 20;
    const url = "/documents";
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
    err.code = 500; 
    throw err;
  }  
}

