document.getElementById('generateBtn').addEventListener('click', async () => {
    const url = document.getElementById('youtubeUrl').value;

    const res = await fetch('http://localhost:3000/generate-tab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: url })
    });

    const data = await res.json();
    document.getElementById('tabOutput').textContent = data.tab;
});