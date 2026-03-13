// server.js
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = 3000;

app.use(bodyParser.json());

// 仮のエンドポイント：YouTubeリンク受け取り → タブ生成
app.post('/generate-tab', (req, res) => {
    const { youtubeUrl } = req.body;

    // TODO: AIモデルで動画解析してタブ生成
    console.log("Received YouTube URL:", youtubeUrl);

    // 仮レスポンス
    const tab = `
e|----------------|
B|----------------|
G|----------------|
D|----------------|
A|----------------|
E|----------------|
    `;
    res.json({ tab });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});