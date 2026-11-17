import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'; 
import { Router } from "express";
import { Pool } from "pg";
import Fs from 'fs/promises'; 

const app = Router();
const port = 3000;

const MAX_FILE_SIZE = 50 * 1024 * 1024;

app.post("/auth/register", async (req, res) =>
{
  try
  {

    const unique = await pool.query("SELECT * FROM users WHERE email = ($1)", [req.body.email]);
    
    if (unique.rows.length > 0)
    {
      return res.status(409).json({"error": "email taken"});
    }
    else
    {
      const task = await pool.query("INSERT INTO users VALUES ($1)", [req.body]);
      console.log(task);
      return res.status(201);
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/auth/login", async (req, res) =>
{
  try
  {
    try
    {
      const result = await pool.query("SELECT token, user FROM users WHERE email = ($1) AND password = ($2)", [req.body.email, req.body.password]);

      if (result.rows.length == 0)
      {
        return res.status(401).json({ "error": "wrong email or password" });
      }
      
      const token = result[0];
      const user = result[1];

      return res.status(200).json({ "token": token, "user": user });
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }

});

async function fileSize (path) {  // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file
  const stat = await Fs.stat(path)
  return stat.size
}

app.post("/documents", async (req, res) =>
{
  try
  {
    const file_size = await fileSize(req.body.file);
    const extension = extname(info.filename).toLowerCase();
      
    if (file_size > MAX_FILE_SIZE) // https://futurestud.io/tutorials/node-js-get-the-size-of-a-file
    {
      return res.status(413).json({ "error": "file must be <= 50 MB" });
    }
  
  }
  catch (err) 
  {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
});

app.get("/documents", async (req, res) =>
{
  
  try
  {
    
  }
   
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
});

