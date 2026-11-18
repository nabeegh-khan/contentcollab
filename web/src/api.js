import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'; 
import Fs from 'fs/promises'; // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file

// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch, https://developer.mozilla.org/en-US/docs/Web/API/Response/status, https://stackoverflow.com/questions/69165892/how-to-throw-an-exception-with-a-status-code

function request(path, options)
{
  
}

function register()
{
  try
  {
    const url = "/auth/register";
    const response = await fetch(url);
    const task = await response.json();
    
    if (response != null)
    {
      const error = new Error("email taken");
      error.code = 409;
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

function login()
{
  try
  {
      const url = "/auth/login"; 
      const task = await fetch(url);
      const result = await task.json(); 

      if (result == null)
      {
        const error = new Error("wrong email or password");
        error.code = 401;
        throw error;
      }
      
      const token = result[0];
      const user = result[1];

      return task.status, task.json({ "token": token, "user": user });
  }
    
  catch (err) 
  {
    err.code = 500; 
    throw err;
  }

}

async function find_fileSize (path) {  // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file
  const stat = await Fs.stat(path);
  return stat.size;
}

function uploadDocument(file, title)
{
  try
  {
    const file_size = await find_fileSize(file);
    const MAX_FILE_SIZE = 50 * 1024 * 1024;

    const extension = extname(file.filename).toLowerCase();
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

function listDocuments({ limit, cursor })
{
  try
  {
    const limit = limit || 20;
    const url = "/documents";
    items = [];

    if (limit > 100)
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, 100); // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/slice
    }
    else if (limit <= 0)
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, 1);
    }
    else
    {
      const task = await fetch(url);
      const result = await task.json(); 
      items = result.slice(0, limit);
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
