import "dotenv/config";
import express from "express";

const app = express();

app.get(`/api`, (_, res) => {
  res.json({
    message: `Hello from the backend!`,
    NODE_ENV: process.env.NODE_ENV,
  });
});

const BACKEND_PORT = process.env.BACKEND_PORT || 3000;
app.listen(BACKEND_PORT, () => {
  console.log(`Server is running on http://localhost:` + BACKEND_PORT);
});