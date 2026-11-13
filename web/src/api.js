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
      return res.status(401).json({ "error": "wrong email or password" });
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }

}

app.post("/documents", async (req, res))
{
  try
  {
    try
    {

    }
      
    catch (e)
    {
      
    }
  }
    
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
}

app.get("/documents/:file, title", async (req, res))
{
  try
  {
    
  }
   
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }  
}

