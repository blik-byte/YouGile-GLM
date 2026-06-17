app.post("/assistant", async (req, res) => {

  try {

    const userInput = req.body.text;

    // Анализируем задачу через GLM

    const completion = await client.chat.completions.create({
      model: "glm-4.5-flash",
      messages: [
        {
          role: "system",
          content: `
Верни ТОЛЬКО JSON без пояснений.

Формат:

{
  "title": "...",
  "task_type": "...",
  "result": "...",
  "estimated_time": "...",
  "steps": [
    "...",
    "...",
    "..."
  ]
}

Сделай название задачи кратким и понятным.
`
        },
        {
          role: "user",
          content: userInput
        }
      ]
    });

    const aiText = completion.choices[0].message.content;

    const taskData = JSON.parse(aiText);

    // Создаём задачу в YouGile

    const createTaskResponse = await fetch(
      "https://rocketup.yougile.com/api-v2/tasks",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.YOUGILE_API_KEY}`
        },
        body: JSON.stringify({
          title: taskData.title,
          columnId: "c34d4600-b9d8-4e07-ab3b-e2a024cc69d1"
        })
      }
    );

    const taskResult = await createTaskResponse.json();

    res.json({
      success: true,
      taskId: taskResult.id,
      analysis: taskData
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});
