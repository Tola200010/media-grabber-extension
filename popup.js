const list = document.getElementById("list");
const empty = document.getElementById("empty");
let tabId;

const fmt = (n) => (n ? (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB") : "");
const send = (m) => chrome.runtime.sendMessage(m);

async function render() {
  const items = await send({ cmd: "list", tabId });
  const jobs = await send({ cmd: "jobs" });
  list.replaceChildren();
  empty.hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="t"></div><div class="u"></div>
      <div class="row"><span class="badge"></span><span class="sz"></span>
      <button class="dl">Download</button><button class="cp">Copy URL</button><span class="msg"></span></div>`;
    li.querySelector(".t").textContent = it.title || it.url;
    li.querySelector(".u").textContent = it.url;
    li.querySelector(".badge").textContent = it.type;
    li.querySelector(".sz").textContent = fmt(it.size);
    const msg = li.querySelector(".msg");
    const job = Object.values(jobs).find((j) => j.url === it.url);
    if (job) msg.textContent = job.state === "error" ? job.error : job.state === "done" && job.done >= job.total ? "done" : `${job.done}/${job.total || "?"}`;
    li.querySelector(".dl").onclick = async () => {
      const r = await send({ cmd: "download", item: it });
      msg.textContent = r.ok ? "started" : r.error;
    };
    li.querySelector(".cp").onclick = () => navigator.clipboard.writeText(it.url);
    list.append(li);
  }
}

document.getElementById("clear").onclick = async () => {
  await send({ cmd: "clear", tabId });
  render();
};

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab.id;
render();
setInterval(render, 1000);
