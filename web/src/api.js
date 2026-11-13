import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'; 

const app = express();
const port = 3000;

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
    catch (er)
    {
      console.error(er);
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

