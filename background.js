const armedByTab = new Map();
const downloadMap = new Map();
const pendingDirectByTab = new Map();
let tokenCounter = 0;

function sanitizePart(value, fallback = "archivo") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 170) || fallback;
}

function sanitizeFolder(value) {
  return String(value || "ChatGPT Prompt Queue")
    .split(/[\\/]+/)
    .map(x => sanitizePart(x, "ChatGPT Prompt Queue"))
    .filter(Boolean)
    .slice(0, 4)
    .join("/");
}

function extFrom(item) {
  for (const value of [item.filename, item.finalUrl, item.url]) {
    const m = String(value || "").match(/\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i);
    if (m) {
      let ext = m[1].toLowerCase();
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  const mime = String(item.mime || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("avif")) return "avif";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "png";
}

function purgeExpired() {
  const now = Date.now();
  for (const [tabId, arm] of armedByTab) {
    if (arm.expiresAt < now) armedByTab.delete(tabId);
  }
}

function latestArm() {
  purgeExpired();
  let best = null;
  for (const [tabId, arm] of armedByTab) {
    if (!best || arm.armedAt > best.arm.armedAt) best = { tabId, arm };
  }
  return best;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!msg?.type) return;

  if (msg.type === "ARM_DOWNLOAD") {
    if (tabId == null) {
      sendResponse({ok:false, error:"No se pudo identificar la pestaña."});
      return true;
    }
    const token = ++tokenCounter;
    armedByTab.set(tabId, {
      token,
      prompt: msg.prompt || "imagen",
      folder: msg.folder || "ChatGPT Prompt Queue",
      armedAt: Date.now(),
      expiresAt: Date.now() + 45000
    });
    sendResponse({ok:true, token});
    return true;
  }

  if (msg.type === "DISARM_DOWNLOAD") {
    if (tabId != null) armedByTab.delete(tabId);
    sendResponse({ok:true});
    return true;
  }


  if (msg.type === "DIRECT_IMAGE_DOWNLOAD") {
    if (tabId == null) {
      sendResponse({ok:false, error:"No se pudo identificar la pestaña."});
      return true;
    }

    const prompt = msg.prompt || "imagen";
    const folder = sanitizeFolder(msg.folder || "ChatGPT Prompt Queue");
    const sourceUrl = String(msg.url || "");
    const extMatch = sourceUrl.match(/\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i);
    let ext = extMatch ? extMatch[1].toLowerCase() : (msg.ext || "png");
    if (ext === "jpeg") ext = "jpg";

    const desiredFilename = `${folder}/${sanitizePart(prompt, "imagen")}.${ext}`;

    // Guardar ANTES de iniciar la descarga para cubrir la carrera entre
    // chrome.downloads.onCreated/onDeterminingFilename y la Promise de download().
    pendingDirectByTab.set(tabId, {
      desiredFilename,
      prompt,
      folder,
      createdAt: Date.now(),
      expiresAt: Date.now() + 15000
    });

    chrome.downloads.download({
      url: sourceUrl,
      filename: desiredFilename,
      conflictAction: "uniquify",
      saveAs: false
    }).then(downloadId => {
      const pending = pendingDirectByTab.get(tabId);
      downloadMap.set(downloadId, {
        tabId,
        token: 0,
        direct: true,
        desiredFilename: pending?.desiredFilename || desiredFilename
      });
      pendingDirectByTab.delete(tabId);
      sendResponse({ok:true, downloadId, filename:desiredFilename});
    }).catch(err => {
      pendingDirectByTab.delete(tabId);
      sendResponse({ok:false, error:String(err?.message || err)});
    });
    return true;
  }


  if (msg.type === "DOWNLOAD_CHECKPOINT") {
    const filename = sanitizePart(msg.filename || "prompts.txt", "prompts.txt");
    const text = String(msg.text ?? "");
    const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    }).then(id => sendResponse({ok:true, downloadId:id}))
      .catch(err => sendResponse({ok:false, error:String(err?.message || err)}));
    return true;
  }
});

chrome.downloads.onCreated.addListener(item => {
  // PRIORIDAD 1: descarga directa iniciada por esta extensión.
  // Como onCreated puede dispararse antes de que chrome.downloads.download()
  // resuelva su Promise, usamos pendingDirectByTab para asociarla.
  const now = Date.now();
  let directMatch = null;

  for (const [tabId, pending] of pendingDirectByTab) {
    if (pending.expiresAt < now) {
      pendingDirectByTab.delete(tabId);
      continue;
    }
    directMatch = {tabId, pending};
    break;
  }

  if (directMatch) {
    downloadMap.set(item.id, {
      tabId: directMatch.tabId,
      token: 0,
      direct: true,
      desiredFilename: directMatch.pending.desiredFilename
    });
    return;
  }

  // PRIORIDAD 2: método nativo antiguo, solo si hubiese una descarga armada.
  const current = latestArm();
  if (!current) return;

  const {tabId, arm} = current;
  downloadMap.set(item.id, {tabId, token:arm.token, direct:false});

  chrome.tabs.sendMessage(tabId, {
    type:"DOWNLOAD_STARTED",
    token:arm.token,
    downloadId:item.id
  }).catch(()=>{});
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let meta = downloadMap.get(item.id);

  // Las descargas directas SIEMPRE reciben el nombre/carpeta exactos.
  if (meta?.direct && meta.desiredFilename) {
    suggest({
      filename: meta.desiredFilename,
      conflictAction: "uniquify"
    });
    return;
  }

  // Si onDeterminingFilename llega antes de que onCreated haya asociado
  // la descarga, recuperar la descarga directa pendiente.
  if (!meta) {
    const now = Date.now();
    for (const [tabId, pending] of pendingDirectByTab) {
      if (pending.expiresAt < now) {
        pendingDirectByTab.delete(tabId);
        continue;
      }
      meta = {
        tabId,
        token: 0,
        direct: true,
        desiredFilename: pending.desiredFilename
      };
      downloadMap.set(item.id, meta);

      suggest({
        filename: pending.desiredFilename,
        conflictAction: "uniquify"
      });
      return;
    }
  }

  // Compatibilidad con el método nativo anterior.
  const current = latestArm();
  if (!meta && current) {
    meta = {tabId:current.tabId, token:current.arm.token, direct:false};
    downloadMap.set(item.id, meta);
  }
  if (!meta) return;

  const arm = armedByTab.get(meta.tabId);
  if (!arm || arm.token !== meta.token) return;

  const folder = sanitizeFolder(arm.folder);
  const filename = sanitizePart(arm.prompt, "imagen") + "." + extFrom(item);

  suggest({
    filename: `${folder}/${filename}`,
    conflictAction: "uniquify"
  });
});

chrome.downloads.onChanged.addListener(delta => {
  const meta = downloadMap.get(delta.id);
  if (!meta) return;

  if (delta.state?.current === "complete") {
    chrome.tabs.sendMessage(meta.tabId, {
      type:"DOWNLOAD_COMPLETE",
      token:meta.token,
      downloadId:delta.id
    }).catch(()=>{});
    downloadMap.delete(delta.id);

    const arm = armedByTab.get(meta.tabId);
    if (arm?.token === meta.token) armedByTab.delete(meta.tabId);
  }

  if (delta.state?.current === "interrupted") {
    chrome.tabs.sendMessage(meta.tabId, {
      type:"DOWNLOAD_FAILED",
      token:meta.token,
      downloadId:delta.id,
      error:delta.error?.current || "Descarga interrumpida"
    }).catch(()=>{});
    downloadMap.delete(delta.id);

    const arm = armedByTab.get(meta.tabId);
    if (arm?.token === meta.token) armedByTab.delete(meta.tabId);
  }
});

const openingTabs = new Set();
chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null || !/^https:\/\/(www\.)?chatgpt\.com\//i.test(tab.url || "")) return;
  if (openingTabs.has(tab.id)) return;
  openingTabs.add(tab.id);
  try {
    await chrome.action.setBadgeText({tabId:tab.id, text:""});
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {type:"TOGGLE_PANEL"});
      if (response?.ok) return;
    } catch {}
    // Las pestañas abiertas antes de cargar/actualizar la extensión no tienen receptor.
    await chrome.scripting.insertCSS({target:{tabId:tab.id}, files:["content.css"]});
    await chrome.scripting.executeScript({target:{tabId:tab.id}, files:["content.js"]});
    const response = await chrome.tabs.sendMessage(tab.id, {type:"SHOW_PANEL"});
    if (!response?.ok) throw new Error("El panel no respondió.");
  } catch (error) {
    console.error("[CPQ] No se pudo abrir el panel", error);
    await chrome.action.setBadgeText({tabId:tab.id, text:"!"});
    await chrome.action.setTitle({tabId:tab.id, title:"No se pudo abrir el panel. Recarga ChatGPT y vuelve a pulsar el icono."});
  } finally {
    openingTabs.delete(tab.id);
  }
});
