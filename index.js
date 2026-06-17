const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.ZAI_API_KEY,
  baseURL: "https://api.z.ai/api/paas/v4"
});

app.get("/", (req, res) => {
  res.send("GLM сервер работает 🚀");
});

app.post("/ai", async (req, res) => {

  try {

    const userInput = req.body.text;

    const completion = await client.chat.completions.create({
      model: "glm-4.5-flash",
      messages: [
        {
          role: "user",
          content: userInput
        }
      ]
    });

    res.json({
      success: true,
      ai: completion.choices[0].message.content
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
