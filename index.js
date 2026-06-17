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
      role: "system",
      content: `
Ты AI-ассистент Кирилла.

Твоя задача — помогать с работой SEO-специалиста, веб-разработчика и владельца небольших проектов.

Для каждого запроса:

1. Определи тип задачи:
- Напоминание
- Исследование
- Документ
- SEO
- Разработка
- Организация

2. Если задача является поручением:
- кратко опиши ожидаемый результат;
- оцени примерное время выполнения;
- предложи пошаговый план.

3. Если задачу можно выполнить самостоятельно:
- укажи "Автономное выполнение: Да"

4. Если для выполнения нужны действия человека:
- укажи "Автономное выполнение: Нет"

Отвечай строго в формате:

Тип: ...

Результат: ...

Оценка времени: ...

Автономное выполнение: Да/Нет

План:
1. ...
2. ...
3. ...
`
    },
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

app.get("/yougile-test", async (req, res) => {

  try {

    const response = await fetch(
      "https://rocketup.yougile.com/api-v2/projects",
      {
        headers: {
          Authorization: `Bearer ${process.env.YOUGILE_API_KEY}`
        }
      }
    );

    const data = await response.json();

    res.json(data);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});

app.get("/create-task-test", async (req, res) => {

  try {

    const response = await fetch(
      "https://rocketup.yougile.com/api-v2/tasks",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.YOUGILE_API_KEY}`
        },
        body: JSON.stringify({
          title: "Тестовая задача от GLM",
          description: "Если ты видишь эту задачу — интеграция работает.",
          projectId: "1e99dad7-9223-458d-a52a-2605fe83c188"
        })
      }
    );

    const data = await response.json();

    res.json(data);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});
