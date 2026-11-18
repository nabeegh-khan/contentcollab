import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'; 
import Fs from 'fs/promises'; // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file

// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch

function request(path, options)
{
  
  return res.status(401).json({"error": "go back to sign-in"});
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
      return res.status(409).json({"error": "email taken"});
    }
    else
    {
      console.log(task);
      return res.status(201);
    }
  }
    
  catch (err)
  {
    console.error(err);
    return res.status(500).json({ error: "Fetch failed" });
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
        return res.status(401).json({ "error": "wrong email or password" });
      }
      
      const token = result[0];
      const user = result[1];

      return return res.status(200).json({ "token": token, "user": user });
  }
    
  catch (err) 
  {
    console.error(err);
    return res.status(500).json({ error: "Fetch failed" });
  }

}

async function find_fileSize (path) {  // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file
  const stat = await Fs.stat(path)
  return stat.size
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
      return res.status(413).json({ "error": "file must be <= 50 MB" });
    }

    if (!acceptable_exts.includes(extension))
    {
      return res.status(400).json({"error": "file type not allowed});
    }

    const result = await fetch(file);
    const task = await result.json();
                                  
    console.log(task);
    return res.status(201);
  
  }
      
  catch (err) 
  {
    console.error(err);
    return res.status(500).json({ error: "Fetch failed" });
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
    console.error(err);
    return res.status(500).json({ error: "Fetch failed" });
  }  
}
