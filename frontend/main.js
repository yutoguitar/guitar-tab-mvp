// frontend/main.js

document.addEventListener("DOMContentLoaded", () => {
    const generateBtn = document.getElementById("generateBtn");
    const youtubeUrlInput = document.getElementById("youtubeUrl");
    const tabOutput = document.getElementById("tabOutput");

    generateBtn.addEventListener("click", async () => {
        const youtubeUrl = youtubeUrlInput.value.trim();
        if (!youtubeUrl) {
            alert("Please enter a YouTube URL.");
            return;
        }

        tabOutput.textContent = "Generating tab...";

        try {
            // サーバーに POST リクエスト送信
            const response = await fetch("http://localhost:3000/generate-tab", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ url: youtubeUrl }) // サーバー側に送る JSON
            });

            if (!response.ok) {
                throw new Error("Server error");
            }

            const data = await response.json();
            tabOutput.textContent = data.tab || "No tab returned";

        } catch (err) {
            console.error(err);
            tabOutput.textContent = "Error generating tab";
        }
    });
});
