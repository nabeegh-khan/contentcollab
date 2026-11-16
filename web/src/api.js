import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'; 
import { Router } from "express";
import Fs from 'fs/promises'; 

const app = Router();
const port = 3000;

const MAX_FILE_SIZE = 50 * 1024 * 1024;

app.post("/auth/register/:email, password, displayName", async (req, res))
{
  try
  {
    try
    {
      return res.status(201);
    }
      
    catch (e)
    {
      console.error(e);
      return res.status(409).json({"error": "email taken"});
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

app.post("/auth/login/:email, password", async (req, res))
{
  try
  {
    try
    {
      return res.status(200).json({ "token": req.body.token, "user": req.body.user });
    }
      
    catch (e)
    {
      console.error(e);
      return res.status(401).json({ "error": "wrong email or password" });
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }

}

async function fileSize (path) {  
  const stat = await Fs.stat(path)

  return stat.size
}

app.post("/documents/:file, title", async (req, res))
{
  try
  {
    try
    {
      try
      {
        return res.status(201);
      }
        
      catch (e)
      {
        console.error(e);
        return res.status(400).json({ "error": "type not allowed" });
      }
    }
  
    const file_size = await fileSize(file);
    
    if (file_size > MAX_FILE_SIZE)
    {
      return res.status(413).json({ "error": "file must be <= 50 MB" });
    }
  }
    
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
}

app.get("/documents", async (req, res))
{
  try
  {
    
  }
   
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
}

