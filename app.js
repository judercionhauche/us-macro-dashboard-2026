const API_URL = "https://us-econ-forecast-worker.judercionhauche.workers.dev";

const qEl = document.getElementById("q");
const ansEl = document.getElementById("answer");
const btn = document.getElementById("askBtn");
const statusEl = document.getElementById("status");

btn.addEventListener("click", async () => {
  const question = qEl.value.trim();
  if (!question) return;

  btn.disabled = true;
  statusEl.textContent = "Fetching data + generating answer...";
  ansEl.textContent = "";

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });

    const data = await resp.json();
if (!resp.ok) throw new Error(data?.detail || data?.error || "Request failed");

    ansEl.textContent = data.answer;
    statusEl.textContent = `Updated: ${data.data_last_updated}`;
  } catch (err) {
    ansEl.textContent = `Error: ${err.message}`;
    statusEl.textContent = "";
  } finally {
    btn.disabled = false;
  }
});
