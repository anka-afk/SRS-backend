require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { AzureOpenAI } = require("openai"); // 使用 AzureOpenAI

const app = express();
const PORT = 5000;

// Azure Whisper 配置
const audioFilePath = process.env["AUDIO_FILE_PATH"] || "<audio file path>";
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const apiVersion = "2024-08-01-preview"; // Azure Whisper API 版本
const deploymentName = "whisper"; // Azure Whisper 部署名称

// 允许的文件类型
const allowedFileTypes = [
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/oga",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
];

// 配置CORS和静态文件目录
app.use(cors({ origin: "http://localhost:8081" }));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const db = new sqlite3.Database("./database.sqlite", (err) => {
  if (err) {
    console.error("连接SQLite数据库失败", err);
  } else {
    console.log("已连接到SQLite数据库");
  }
});

// 创建数据库表
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      question_id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      description TEXT,
      media_files TEXT,
      correct_answer TEXT,
      show_spectrum INTEGER NOT NULL,
      order_number INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      recording_id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      recording_url TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions (question_id)
    )
  `);
});

// 配置multer用于文件上传
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (allowedFileTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file format. Please upload a file in one of the following formats: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm."
        ),
        false
      );
    }
  },
});

// 上传题目数据的API
app.post("/api/questions", upload.array("media_files", 10), (req, res) => {
  const { text, description, order_number, show_spectrum, correct_answer } =
    req.body;
  const mediaFiles = req.files.map((file) => `/uploads/${file.filename}`);

  if (!text || !order_number) {
    return res.status(400).json({ error: "缺少必填字段：text, order_number" });
  }

  db.run(
    "INSERT INTO questions (text, description, media_files, correct_answer, show_spectrum, order_number) VALUES (?, ?, ?, ?, ?, ?)",
    [
      text,
      description,
      JSON.stringify(mediaFiles),
      correct_answer,
      show_spectrum === "true" ? 1 : 0,
      order_number,
    ],
    function (err) {
      if (err) {
        res.status(500).json({ error: "添加题目失败" });
      } else {
        res.json({
          success: true,
          message: "题目已添加",
          question_id: this.lastID,
        });
      }
    }
  );
});

// 获取所有题目
app.get("/api/questions", (req, res) => {
  db.all("SELECT * FROM questions ORDER BY order_number", [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: "获取题目失败" });
    } else {
      rows.forEach((row) => (row.media_files = JSON.parse(row.media_files)));
      res.json(rows);
    }
  });
});

// 调用 Azure Whisper API 进行语音识别的函数
async function transcribeAudio(filePath, retries = 3) {
  const client = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion,
    deployment: deploymentName,
  });

  try {
    const result = await client.audio.transcriptions.create({
      model: "",
      file: fs.createReadStream(filePath),
    });

    if (result.status !== 200) {
      throw new Error("语音识别失败");
    }

    return result.text;
  } catch (error) {
    if (error.code === "ECONNRESET" && retries > 0) {
      console.log("网络连接问题，正在重试...");
      return transcribeAudio(filePath, retries - 1); // 重试三次
    } else {
      throw error;
    }
  }
}

// 录音上传并保存的 API
app.post("/api/recordings", upload.single("recording"), (req, res) => {
  const { user_id, question_id } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "未上传录音文件" });
  }

  // 假设你希望把录音文件和用户信息保存到数据库中
  const filePath = `/uploads/${req.file.filename}`;
  db.run(
    "INSERT INTO recordings (user_id, question_id, recording_url) VALUES (?, ?, ?)",
    [user_id, question_id, filePath],
    function (err) {
      if (err) {
        return res.status(500).json({ error: "保存录音失败" });
      }

      res.json({
        success: true,
        message: "录音已保存",
        recording_id: this.lastID,
      });
    }
  );
});

// 录音上传并进行语音识别的 API
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const { question_id } = req.body;

  // 检查是否上传了录音文件
  if (!req.file) {
    return res.status(400).json({ error: "未上传录音文件" });
  }

  const audioFilePath = path.join(__dirname, req.file.path);

  try {
    // 调用 Azure Whisper API 进行语音识别
    const transcript = await transcribeAudio(audioFilePath);

    // 检查识别结果是否为空
    if (!transcript) {
      return res.status(500).json({ error: "语音识别失败" });
    }

    // 将识别的文本返回给前端
    res.json({ text: transcript });
  } catch (error) {
    console.error("Azure Whisper API 调用失败:", error);
    res.status(500).json({ error: "语音识别失败" });
  } finally {
    // 删除音频文件以释放服务器空间
    fs.unlink(audioFilePath, (err) => {
      if (err) {
        console.error("删除音频文件失败:", err);
      }
    });
  }
});

// 启动服务器
app.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));
