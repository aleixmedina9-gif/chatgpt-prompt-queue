(() => {
  if (window.__CPQ_V2__) return;
  window.__CPQ_V2__ = true;

  const STORAGE_KEY = "cpq_v2_state";
  const VERSION = "2.3.2";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const DEFAULT = {
    items: [],
    originalFileName: "prompts.txt",
    running: false,
    paused: false,
    currentId: null,
    panelVisible: true,
    activeTab: "queue",
    sessionSerial: 0,
    status: "Preparado",
    statusKind: "idle",
    settings: {
      waitSeconds: 15,
      maxAttempts: 3,
      retryDelaySeconds: 3,
      generationTimeoutSeconds: 240,
      downloadStartTimeoutSeconds: 3,
      downloadFolder: "ChatGPT Prompt Queue",
      checkpointOnStop: true,
      promptPrefix: "Create image:",
      promptSuffix: "",
      imageMode: "new",
      aspectRatio: "16:9",
      imageQuality: "standard",
      language: "es"
    }
  };

  let state = structuredClone(DEFAULT);
  let sessionToken = 0;
  let activeDownload = null;
  let toastTimer = null;
  let renderScheduled = false;

  class InterruptedError extends Error {
    constructor(message = "Interrumpido") {
      super(message);
      this.name = "InterruptedError";
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function cleanLine(x) {
    return String(x || "").replace(/\uFEFF/g, "").trim();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[c]));
  }


  const I18N = {
    es: {
      queue:"Cola", settings:"Configuración", total:"Total", done:"Hechos", pending:"Pend.", failed:"Fallos",
      import:"Importar prompts", importSub:"Arrastra un .txt o pulsa aquí", start:"▶ Iniciar", pause:"Ⅱ Pausar",
      resume:"▶ Reanudar", stop:"■ Detener", retry:"↻ Reintentar fallidos", export:"⇩ Exportar pendientes",
      clear:"Limpiar", status:"ESTADO", current:"COLA ACTUAL", smart:"Ventana inteligente",
      empty:"Cola vacía", emptySub:"Escribe prompts o importa un archivo .txt.",
      manual:"Escribir prompts", manualSub:"Un prompt por línea o separados por una línea en blanco.",
      add:"＋ Añadir a la cola", flow:"Flujo", downloads:"Descargas", behavior:"Generación",
      language:"Idioma", prefix:"Texto antes de cada prompt", suffix:"Texto después de cada prompt",
      ratio:"Relación de aspecto", quality:"Calidad / preferencia", imageMode:"Modo de imagen",
      newImage:"Nueva imagen", currentChat:"Chat actual", save:"Guardar configuración",
      folder:"Carpeta dentro de Descargas", checkpoint:"Exportar TXT al detener"
    },
    en: {
      queue:"Queue", settings:"Settings", total:"Total", done:"Done", pending:"Pending", failed:"Failed",
      import:"Import prompts", importSub:"Drop a .txt file or click here", start:"▶ Start", pause:"Ⅱ Pause",
      resume:"▶ Resume", stop:"■ Stop", retry:"↻ Retry failed", export:"⇩ Export pending",
      clear:"Clear", status:"STATUS", current:"CURRENT QUEUE", smart:"Smart window",
      empty:"Empty queue", emptySub:"Write prompts or import a .txt file.",
      manual:"Write prompts", manualSub:"One prompt per line or separated by a blank line.",
      add:"＋ Add to queue", flow:"Flow", downloads:"Downloads", behavior:"Generation",
      language:"Language", prefix:"Text before each prompt", suffix:"Text after each prompt",
      ratio:"Aspect ratio", quality:"Quality / preference", imageMode:"Image mode",
      newImage:"New image", currentChat:"Current chat", save:"Save settings",
      folder:"Folder inside Downloads", checkpoint:"Export TXT on stop"
    },
    ca: {
      queue:"Cua", settings:"Configuració", total:"Total", done:"Fets", pending:"Pend.", failed:"Errors",
      import:"Importar prompts", importSub:"Arrossega un .txt o prem aquí", start:"▶ Iniciar", pause:"Ⅱ Pausar",
      resume:"▶ Reprendre", stop:"■ Aturar", retry:"↻ Reintentar errors", export:"⇩ Exportar pendents",
      clear:"Netejar", status:"ESTAT", current:"CUA ACTUAL", smart:"Finestra intel·ligent",
      empty:"Cua buida", emptySub:"Escriu prompts o importa un fitxer .txt.",
      manual:"Escriure prompts", manualSub:"Un prompt per línia o separats per una línia en blanc.",
      add:"＋ Afegir a la cua", flow:"Flux", downloads:"Descàrregues", behavior:"Generació",
      language:"Idioma", prefix:"Text abans de cada prompt", suffix:"Text després de cada prompt",
      ratio:"Relació d'aspecte", quality:"Qualitat / preferència", imageMode:"Mode d'imatge",
      newImage:"Imatge nova", currentChat:"Xat actual", save:"Desar configuració",
      folder:"Carpeta dins de Descàrregues", checkpoint:"Exportar TXT en aturar"
    }
  };

  function tr(key) {
    const lang = state.settings?.language || "es";
    return I18N[lang]?.[key] || I18N.es[key] || key;
  }

  function buildFinalPrompt(raw) {
    const prefix = String(state.settings.promptPrefix || "").trim();
    const suffix = String(state.settings.promptSuffix || "").trim();
    const parts = [];
    if (prefix) parts.push(prefix);
    parts.push(raw.trim());
    if (suffix) parts.push(suffix);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 2 && r.height > 2;
  }

  function textOf(el) {
    return (
      (el?.getAttribute?.("aria-label") || "") + " " +
      (el?.getAttribute?.("title") || "") + " " +
      (el?.innerText || "") + " " +
      (el?.textContent || "")
    ).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function stats() {
    const total = state.items.length;
    const done = state.items.filter(x => x.status === "done").length;
    const failed = state.items.filter(x => x.status === "failed").length;
    const running = state.items.filter(x => x.status === "running").length;
    return {total, done, failed, running, pending: total - done - failed - running};
  }

  async function loadState() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) {
      const saved = data[STORAGE_KEY];
      state = {
        ...structuredClone(DEFAULT),
        ...saved,
        settings: {...DEFAULT.settings, ...(saved.settings || {})}
      };
    }

    // Nunca continuar automáticamente tras recarga.
    if (state.running || state.currentId) {
      const current = state.items.find(x => x.id === state.currentId);
      if (current && current.status === "running") current.status = "pending";
      state.running = false;
      state.paused = false;
      state.currentId = null;
      state.status = "Sesión recuperada. Pulsa Iniciar para continuar.";
      state.statusKind = "idle";
      await saveState();
    }
  }

  async function saveState() {
    await chrome.storage.local.set({[STORAGE_KEY]: state});
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function toast(msg) {
    const el = document.querySelector("#cpq-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function itemWindow() {
    if (!state.items.length) return {start:0, items:[]};
    let idx = state.currentId ? state.items.findIndex(x => x.id === state.currentId) : -1;
    if (idx < 0) idx = state.items.findIndex(x => x.status === "pending");
    if (idx < 0) idx = Math.max(0, state.items.length - 1);
    const start = Math.max(0, idx - 6);
    return {start, items:state.items.slice(start, start + 22)};
  }

  function render() {
    const root = document.querySelector("#cpq-root");
    if (!root) return;

    root.classList.toggle("hidden", !state.panelVisible);
    root.dataset.tab = state.activeTab;

    const st = stats();
    for (const [id, value] of Object.entries(st)) {
      const el = root.querySelector(`#cpq-${id}`);
      if (el) el.textContent = value;
    }

    const percent = st.total ? Math.round(((st.done + st.failed) / st.total) * 100) : 0;
    root.querySelector("#cpq-progress-fill").style.width = percent + "%";
    root.querySelector("#cpq-progress-label").textContent = percent + "%";

    const status = root.querySelector("#cpq-status");
    status.className = "cpq-status " + state.statusKind;
    root.querySelector("#cpq-status-text").textContent = state.status;

    const pauseBtn = root.querySelector("#cpq-pause");
    pauseBtn.disabled = !state.running && !state.paused;
    pauseBtn.textContent = state.paused ? tr("resume") : tr("pause");

    root.querySelector("#cpq-start").disabled = state.running;
    root.querySelector("#cpq-stop").disabled = !state.running && !state.paused && !state.currentId;

    for (const [key, sel] of [
      ["waitSeconds","#cpq-wait"],
      ["maxAttempts","#cpq-attempts"],
      ["retryDelaySeconds","#cpq-retry-delay"],
      ["generationTimeoutSeconds","#cpq-gen-timeout"],
      ["downloadStartTimeoutSeconds","#cpq-download-timeout"],
      ["downloadFolder","#cpq-folder"]
    ]) {
      const el = root.querySelector(sel);
      if (el && document.activeElement !== el) el.value = state.settings[key];
    }
    root.querySelector("#cpq-checkpoint").checked = !!state.settings.checkpointOnStop;
    root.querySelector("#cpq-prefix").value = state.settings.promptPrefix ?? "Create image:";
    root.querySelector("#cpq-suffix").value = state.settings.promptSuffix ?? "";
    root.querySelector("#cpq-image-mode").value = state.settings.imageMode || "new";
    root.querySelector("#cpq-ratio").value = state.settings.aspectRatio || "16:9";
    root.querySelector("#cpq-quality").value = state.settings.imageQuality || "standard";
    root.querySelector("#cpq-language").value = state.settings.language || "es";

    root.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.dataset.i18n;
      if (key === "pause") el.textContent = state.paused ? tr("resume") : tr("pause");
      else el.textContent = tr(key);
    });


    const {start, items} = itemWindow();
    const list = root.querySelector("#cpq-list");
    if (!items.length) {
      list.innerHTML = `<div class="cpq-empty">
        <div class="cpq-empty-orb">✦</div>
        <b>Cola vacía</b>
        <span>Importa un archivo .txt para empezar.</span>
      </div>`;
    } else {
      list.innerHTML = items.map((it, offset) => {
        const realIndex = start + offset;
        const badge = it.status === "done" ? "Hecho" :
                      it.status === "failed" ? "Fallido" :
                      it.status === "running" ? "Procesando" : "Pendiente";
        return `<div class="cpq-item ${it.status}">
          <div class="cpq-index">${realIndex + 1}</div>
          <div class="cpq-item-main">
            <div class="cpq-prompt">${esc(it.prompt)}</div>
            <div class="cpq-item-meta">
              <span>${badge}</span>
              <span>Intentos ${it.attempts || 0}/${state.settings.maxAttempts}</span>
              ${it.lastError ? `<span class="err">${esc(it.lastError).slice(0, 80)}</span>` : ""}
            </div>
          </div>
        </div>`;
      }).join("");
    }

    root.querySelectorAll("[data-tab-btn]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tabBtn === state.activeTab);
    });
    root.querySelector("#cpq-queue-view").classList.toggle("active", state.activeTab === "queue");
    root.querySelector("#cpq-settings-view").classList.toggle("active", state.activeTab === "settings");
  }

  function mount() {
    if (document.querySelector("#cpq-root")) return;

    const root = document.createElement("aside");
    root.id = "cpq-root";
    root.innerHTML = `
      <div class="cpq-glow g1"></div><div class="cpq-glow g2"></div>
      <header class="cpq-header">
        <div class="cpq-brand">
          <div class="cpq-logo"><span>✦</span></div>
          <div><b>Prompt Queue</b><small>ChatGPT Image Automation · v${VERSION}</small></div>
        </div>
        <button class="cpq-icon-btn" id="cpq-hide" title="Ocultar">×</button>
      </header>

      <nav class="cpq-tabs">
        <button data-tab-btn="queue" class="active" data-i18n="queue">Cola</button>
        <button data-tab-btn="settings" data-i18n="settings">Configuración</button>
      </nav>

      <section class="cpq-view active" id="cpq-queue-view">
        <div class="cpq-stats">
          <div><b id="cpq-total">0</b><span>Total</span></div>
          <div><b id="cpq-done">0</b><span>Hechos</span></div>
          <div><b id="cpq-pending">0</b><span>Pend.</span></div>
          <div><b id="cpq-failed">0</b><span>Fallos</span></div>
        </div>

        <div class="cpq-progress">
          <div class="cpq-progress-track"><i id="cpq-progress-fill"></i></div>
          <span id="cpq-progress-label">0%</span>
        </div>

        <div class="cpq-manual-card">
          <div class="cpq-manual-head"><b data-i18n="manual">Escribir prompts</b><span data-i18n="manualSub">Un prompt por línea o separados por una línea en blanco.</span></div>
          <textarea id="cpq-manual" placeholder="Jack Daniel's Botella Cristal (70 cl.) Foto frontal del producto&#10;&#10;Jack Daniel's Botella Cristal (70 cl.) Parte de atras del producto"></textarea>
          <button id="cpq-add-manual" class="cpq-add-manual" data-i18n="add">＋ Añadir a la cola</button>
        </div>
        <label class="cpq-drop" id="cpq-drop">
          <input id="cpq-file" type="file" accept=".txt,text/plain">
          <div class="cpq-drop-icon">⇧</div>
          <div><b data-i18n="import">Importar prompts</b><span data-i18n="importSub">Arrastra un .txt o pulsa aquí</span></div>
        </label>

        <div class="cpq-controls">
          <button class="primary" id="cpq-start" data-i18n="start">▶ Iniciar</button>
          <button id="cpq-pause" data-i18n="pause">Ⅱ Pausar</button>
          <button class="danger" id="cpq-stop" data-i18n="stop">■ Detener</button>
        </div>

        <div class="cpq-subcontrols">
          <button id="cpq-retry-failed" data-i18n="retry">↻ Reintentar fallidos</button>
          <button id="cpq-export" data-i18n="export">⇩ Exportar pendientes</button>
          <button id="cpq-clear" data-i18n="clear">Limpiar</button>
        </div>

        <div class="cpq-status idle" id="cpq-status">
          <span class="cpq-status-dot"></span>
          <div><small>ESTADO</small><b id="cpq-status-text">Preparado</b></div>
        </div>

        <div class="cpq-list-head"><span>COLA ACTUAL</span><span>Ventana inteligente</span></div>
        <div class="cpq-list" id="cpq-list"></div>
      </section>

      <section class="cpq-view" id="cpq-settings-view">
        <div class="cpq-settings-card">
          <h3 data-i18n="behavior">Generación</h3>
          <label class="wide"><span data-i18n="prefix">Texto antes de cada prompt</span><input id="cpq-prefix" type="text" maxlength="180" placeholder="Create image:"></label>
          <label class="wide"><span data-i18n="suffix">Texto después de cada prompt</span><input id="cpq-suffix" type="text" maxlength="240" placeholder=""></label>
          <div class="cpq-grid cpq-grid-top">
            <label><span data-i18n="imageMode">Modo de imagen</span><select id="cpq-image-mode"><option value="new">Nueva imagen</option><option value="current">Chat actual</option></select></label>
            <label><span data-i18n="ratio">Relación de aspecto</span><select id="cpq-ratio"><option>16:9</option><option>1:1</option><option>9:16</option><option>4:3</option><option>3:4</option></select></label>
            <label><span data-i18n="quality">Calidad / preferencia</span><select id="cpq-quality"><option value="standard">Estándar</option><option value="high">Alta</option><option value="fast">Rápida</option></select></label>
            <label><span data-i18n="language">Idioma</span><select id="cpq-language"><option value="es">Español</option><option value="en">English</option><option value="ca">Català</option></select></label>
          </div>
          <p>El prefijo y el sufijo se añaden al enviar, pero el archivo descargado conserva como nombre el prompt original del producto.</p>
        </div>

        <div class="cpq-settings-card">
          <h3 data-i18n="flow">Flujo</h3>
          <div class="cpq-grid">
            <label><span>Espera después de descargar</span><div><input id="cpq-wait" type="number" min="0" max="600"><em>s</em></div></label>
            <label><span>Máximo de intentos</span><div><input id="cpq-attempts" type="number" min="1" max="10"></div></label>
            <label><span>Espera entre reintentos</span><div><input id="cpq-retry-delay" type="number" min="0" max="60"><em>s</em></div></label>
            <label><span>Tiempo máximo de generación</span><div><input id="cpq-gen-timeout" type="number" min="30" max="900"><em>s</em></div></label>
          </div>
        </div>

        <div class="cpq-settings-card">
          <h3 data-i18n="downloads">Descargas</h3>
          <label class="wide"><span data-i18n="folder">Carpeta dentro de Descargas</span><input id="cpq-folder" type="text" maxlength="80" placeholder="ChatGPT Prompt Queue"></label>
          <label class="wide"><span>Tiempo para detectar inicio de descarga</span><div class="inline"><input id="cpq-download-timeout" type="number" min="1" max="30"><em>s</em></div></label>
          <p>La extensión obtiene la imagen generada directamente y la descarga sin pulsar Share, Guardar ni abrir otras páginas.</p>
        </div>

        <div class="cpq-settings-card">
          <h3>Checkpoint</h3>
          <label class="switch-row"><span><b data-i18n="checkpoint">Exportar TXT al detener</b><small>Conserva únicamente los prompts que aún no están completados.</small></span><input id="cpq-checkpoint" type="checkbox"><i></i></label>
        </div>

        <button class="cpq-save-settings" id="cpq-save-settings" data-i18n="save">Guardar configuración</button>
      </section>

      <div id="cpq-toast" class="cpq-toast"></div>
    `;
    (document.body || document.documentElement).appendChild(root);

    bindUI(root);
  }

  function bindUI(root) {
    root.querySelectorAll("[data-tab-btn]").forEach(btn => {
      btn.addEventListener("click", async () => {
        state.activeTab = btn.dataset.tabBtn;
        await saveState();
        scheduleRender();
      });
    });

    root.querySelector("#cpq-hide").onclick = async () => {
      state.panelVisible = false;
      await saveState();
      scheduleRender();
    };

    const fileInput = root.querySelector("#cpq-file");
    const drop = root.querySelector("#cpq-drop");

    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("drag");
      const f = e.dataTransfer?.files?.[0];
      if (f) importTxt(f);
    });
    fileInput.onchange = () => fileInput.files?.[0] && importTxt(fileInput.files[0]);


    root.querySelector("#cpq-add-manual").onclick = async () => {
      const area = root.querySelector("#cpq-manual");
      const raw = area.value || "";
      const prompts = raw.split(/\r?\n\s*\r?\n|\r?\n/).map(cleanLine).filter(Boolean);
      if (!prompts.length) return toast("No hay prompts escritos.");
      for (const prompt of prompts) {
        state.items.push({id:uid(), prompt, status:"pending", attempts:0, lastError:""});
      }
      area.value = "";
      state.status = `${prompts.length} prompts añadidos`;
      state.statusKind = "ok";
      await saveState();
      scheduleRender();
    };

    root.querySelector("#cpq-start").onclick = startQueue;
    root.querySelector("#cpq-pause").onclick = togglePause;
    root.querySelector("#cpq-stop").onclick = stopQueue;

    root.querySelector("#cpq-retry-failed").onclick = async () => {
      let n = 0;
      for (const item of state.items) {
        if (item.status === "failed") {
          item.status = "pending";
          item.attempts = 0;
          item.lastError = "";
          n++;
        }
      }
      await saveState();
      scheduleRender();
      toast(`${n} prompts devueltos a pendientes.`);
    };

    root.querySelector("#cpq-export").onclick = exportPendingFile;

    root.querySelector("#cpq-clear").onclick = async () => {
      if (state.running) return toast("Detén la cola antes de limpiarla.");
      state.items = [];
      state.currentId = null;
      state.status = "Cola vacía";
      state.statusKind = "idle";
      await saveState();
      scheduleRender();
    };

    root.querySelector("#cpq-save-settings").onclick = async () => {
      readSettingsFromUI();
      await saveState();
      scheduleRender();
      toast("Configuración guardada.");
    };

    root.querySelectorAll("#cpq-settings-view input,#cpq-settings-view select").forEach(el => {
      el.addEventListener("change", () => {
        readSettingsFromUI();
        saveState();
      });
    });
  }

  function readSettingsFromUI() {
    const q = s => document.querySelector(s);
    state.settings.waitSeconds = clampNum(q("#cpq-wait")?.value, 0, 600, 15);
    state.settings.maxAttempts = clampNum(q("#cpq-attempts")?.value, 1, 10, 3);
    state.settings.retryDelaySeconds = clampNum(q("#cpq-retry-delay")?.value, 0, 60, 3);
    state.settings.generationTimeoutSeconds = clampNum(q("#cpq-gen-timeout")?.value, 30, 900, 240);
    state.settings.downloadStartTimeoutSeconds = clampNum(q("#cpq-download-timeout")?.value, 1, 30, 3);
    state.settings.downloadFolder = cleanFolder(q("#cpq-folder")?.value || "ChatGPT Prompt Queue");
    state.settings.checkpointOnStop = !!q("#cpq-checkpoint")?.checked;
    state.settings.promptPrefix = String(q("#cpq-prefix")?.value ?? "Create image:").trim();
    state.settings.promptSuffix = String(q("#cpq-suffix")?.value ?? "").trim();
    state.settings.imageMode = q("#cpq-image-mode")?.value || "new";
    state.settings.aspectRatio = q("#cpq-ratio")?.value || "16:9";
    state.settings.imageQuality = q("#cpq-quality")?.value || "standard";
    state.settings.language = q("#cpq-language")?.value || "es";

  }

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  }

  function cleanFolder(value) {
    return String(value || "ChatGPT Prompt Queue")
      .replace(/[<>:"|?*\x00-\x1F]/g, "")
      .replace(/[\\/]+/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .trim()
      .slice(0, 80) || "ChatGPT Prompt Queue";
  }

  async function importTxt(file) {
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      toast("Selecciona un archivo .txt.");
      return;
    }
    if (state.running) {
      toast("Detén la cola antes de cargar otro archivo.");
      return;
    }

    const lines = (await file.text())
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    state.items = lines.map(prompt => ({
      id: uid(),
      prompt,
      status:"pending",
      attempts:0,
      lastError:""
    }));
    state.originalFileName = file.name || "prompts.txt";
    state.currentId = null;
    state.status = `${lines.length} prompts importados`;
    state.statusKind = "ok";
    await saveState();
    scheduleRender();
  }

  function isSessionActive(token) {
    return token === sessionToken && state.running && !state.paused;
  }

  function assertActive(token) {
    if (!isSessionActive(token)) throw new InterruptedError();
  }

  async function interruptibleSleep(ms, token) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      assertActive(token);
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  async function startQueue() {
    if (state.running) return;
    if (!state.items.some(x => x.status === "pending" || x.status === "failed")) {
      toast("No hay prompts pendientes.");
      return;
    }

    // Los fallidos permanecen fallidos hasta pulsar Reintentar fallidos.
    if (!state.items.some(x => x.status === "pending")) {
      toast("Solo quedan fallidos. Usa “Reintentar fallidos”.");
      return;
    }

    readSettingsFromUI();
    state.running = true;
    state.paused = false;
    state.sessionSerial++;
    state.status = "Automatización iniciada";
    state.statusKind = "running";
    const token = ++sessionToken;
    await saveState();
    scheduleRender();
    runQueue(token);
  }

  async function togglePause() {
    if (!state.running && state.paused) {
      // Reanudar.
      state.running = true;
      state.paused = false;
      state.status = "Reanudando…";
      state.statusKind = "running";
      const token = ++sessionToken;
      await saveState();
      scheduleRender();
      runQueue(token);
      return;
    }

    if (!state.running) return;

    // Pausa REAL e inmediata: invalida el worker actual.
    state.paused = true;
    state.running = false;
    ++sessionToken;
    activeDownload = null;
    await chrome.runtime.sendMessage({type:"DISARM_DOWNLOAD"}).catch(()=>{});

    const current = state.items.find(x => x.id === state.currentId);
    if (current && current.status === "running") {
      current.status = "pending";
      current.attempts = Math.max(0, (current.attempts || 1) - 1);
      current.lastError = "";
    }
    state.currentId = null;
    state.status = "Pausado. No se enviarán más prompts.";
    state.statusKind = "paused";
    await saveState();
    scheduleRender();
  }

  async function stopQueue() {
    // Detención REAL e inmediata.
    state.running = false;
    state.paused = false;
    ++sessionToken;
    activeDownload = null;
    await chrome.runtime.sendMessage({type:"DISARM_DOWNLOAD"}).catch(()=>{});

    const current = state.items.find(x => x.id === state.currentId);
    if (current && current.status === "running") {
      current.status = "pending";
      current.attempts = Math.max(0, (current.attempts || 1) - 1);
      current.lastError = "";
    }
    state.currentId = null;
    state.status = "Detenido. La página vuelve a funcionar normalmente.";
    state.statusKind = "idle";
    await saveState();
    scheduleRender();

    if (state.settings.checkpointOnStop && state.items.length) {
      await exportPendingFile();
    }
  }

  async function exportPendingFile() {
    const remaining = state.items
      .filter(x => x.status !== "done")
      .map(x => x.prompt);

    const text = remaining.length ? remaining.join("\r\n") + "\r\n" : "";
    const filename = state.originalFileName || "prompts.txt";

    const res = await chrome.runtime.sendMessage({
      type:"DOWNLOAD_CHECKPOINT",
      filename,
      text
    }).catch(err => ({ok:false, error:String(err)}));

    if (res?.ok) {
      toast(`TXT exportado: ${remaining.length} prompts pendientes.`);
    } else {
      toast("No se pudo exportar el TXT pendiente.");
    }
  }

  function findComposer() {
    const candidates = [...document.querySelectorAll(
      'textarea,[contenteditable="true"][role="textbox"],[contenteditable="true"],[role="textbox"]'
    )].filter(el => !el.closest("#cpq-root") && isVisible(el) &&
      !el.disabled && el.getAttribute("aria-disabled") !== "true");

    if (!candidates.length) return null;

    return candidates.map(el => {
      const meta = (
        (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("data-placeholder") || "")
      ).toLowerCase();

      const r = el.getBoundingClientRect();
      let score = 0;
      if (el.id === "prompt-textarea") score += 200;
      if (el.classList.contains("ProseMirror")) score += 100;
      if (/message|ask|prompt|describe|mensaje|pregunta/.test(meta)) score += 60;
      if (r.top > innerHeight * .45) score += 25;
      if (r.width > 250) score += 15;
      if (el.closest("form")) score += 10;
      return {el, score};
    }).sort((a,b) => b.score - a.score)[0]?.el || null;
  }

  function setComposerValue(el, text) {
    try { el.focus({preventScroll:true}); } catch { el.focus(); }

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event("input", {bubbles:true}));
      el.dispatchEvent(new Event("change", {bubbles:true}));
      return;
    }

    // Contenteditable / ProseMirror.
    el.textContent = "";
    el.dispatchEvent(new InputEvent("beforeinput", {
      bubbles:true, cancelable:true, inputType:"insertText", data:text
    }));
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", {
      bubbles:true, inputType:"insertText", data:text
    }));
  }

  function findSendButton(composer) {
    const roots = [];
    const form = composer.closest("form");
    if (form) roots.push(form);

    let node = composer.parentElement;
    for (let i=0; i<5 && node; i++, node=node.parentElement) roots.push(node);

    for (const root of roots) {
      const ranked = [...root.querySelectorAll('button,[role="button"]')]
        .filter(el => !el.closest("#cpq-root") && isVisible(el) &&
          !el.disabled && el.getAttribute("aria-disabled") !== "true")
        .map(el => {
          const t = textOf(el);
          const r = el.getBoundingClientRect();
          const cr = composer.getBoundingClientRect();
          let score = 0;
          if (el.getAttribute("data-testid") === "send-button") score += 200;
          if (/send|submit|enviar/.test(t)) score += 100;
          if (/arrow up/.test(t)) score += 70;
          if (r.left > cr.left + cr.width * .55) score += 20;
          if (Math.abs(r.top - cr.top) < 150) score += 20;
          if (el.disabled || el.getAttribute("aria-disabled") === "true") score -= 300;
          const isSend = el.getAttribute("data-testid") === "send-button" ||
            /send|submit|enviar|arrow up/.test(t) || el.getAttribute("type") === "submit";
          return {el, score: isSend ? score : 0};
        })
        .filter(x => x.score > 0)
        .sort((a,b) => b.score - a.score);

      if (ranked[0]) return ranked[0].el;
    }
    return null;
  }

  async function submitPrompt(prompt, token) {
    assertActive(token);
    const composer = findComposer();
    if (!composer) throw new Error("No encuentro el cuadro de texto de ChatGPT.");

    setComposerValue(composer, prompt);
    await interruptibleSleep(250, token);

    const send = findSendButton(composer);
    if (send) {
      send.click();
      return;
    }

    // Fallback, siempre dirigido al composer.
    try { composer.focus({preventScroll:true}); } catch { composer.focus(); }
    composer.dispatchEvent(new KeyboardEvent("keydown", {
      key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true, cancelable:true
    }));
    composer.dispatchEvent(new KeyboardEvent("keyup", {
      key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true, cancelable:true
    }));
  }

  function imageSignature(img) {
    return [
      img.currentSrc || img.src || "",
      img.alt || "",
      img.naturalWidth || 0,
      img.naturalHeight || 0
    ].join("|");
  }

  function snapshotImages() {
    return new Set([...document.images].filter(isVisible).map(imageSignature));
  }

  function looksGeneratedImage(img) {
    if (!isVisible(img)) return false;
    const r = img.getBoundingClientRect();
    const alt = String(img.alt || "").toLowerCase();
    const src = String(img.currentSrc || img.src || "").toLowerCase();
    if (r.width < 180 || r.height < 180) return false;
    if (/avatar|profile|emoji|icon|logo/.test(alt)) return false;
    if (src.startsWith("data:image/svg")) return false;
    return true;
  }

  async function waitForNewImage(before, token) {
    const timeoutMs = state.settings.generationTimeoutSeconds * 1000;
    const start = Date.now();
    let candidate = null;
    let candidateAt = 0;

    while (Date.now() - start < timeoutMs) {
      assertActive(token);

      const fresh = [...document.images]
        .filter(looksGeneratedImage)
        .filter(img => !before.has(imageSignature(img)));

      if (fresh.length) {
        fresh.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        const best = fresh[0];

        if (candidate !== best) {
          candidate = best;
          candidateAt = Date.now();
        }

        // Evita previews efímeras.
        if (Date.now() - candidateAt >= 650) return candidate;
      }

      await sleep(350);
    }

    throw new Error(`No apareció una imagen nueva en ${state.settings.generationTimeoutSeconds} s.`);
  }


  async function imageToDownloadableUrl(img, token) {
    assertActive(token);

    const src = img.currentSrc || img.src || "";
    if (!src) throw new Error("La imagen generada no tiene una URL utilizable.");

    // Si ya es blob/data/http(s), usarla directamente.
    if (/^(blob:|data:|https?:)/i.test(src)) {
      // Para HTTP intentamos obtener un blob desde la propia sesión de ChatGPT.
      // Así no navegamos a la URL ni pulsamos Share/Save.
      if (/^https?:/i.test(src)) {
        try {
          const res = await fetch(src, {credentials:"include", cache:"no-store"});
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 0) {
              const objectUrl = URL.createObjectURL(blob);
              return {
                url: objectUrl,
                revoke:true,
                ext: blob.type.includes("webp") ? "webp" :
                     blob.type.includes("jpeg") ? "jpg" :
                     blob.type.includes("png") ? "png" : "png"
              };
            }
          }
        } catch {}
      }
      return {url:src, revoke:false, ext:"png"};
    }

    throw new Error("No se pudo obtener la imagen directamente.");
  }

  function waitForDirectDownloadComplete(downloadId, token) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 120000;

      const poll = setInterval(() => {
        if (!isSessionActive(token)) {
          clearInterval(poll);
          activeDownload = null;
          reject(new InterruptedError());
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          activeDownload = null;
          reject(new Error("La descarga no terminó en 120 s."));
        }
      }, 200);

      activeDownload = {
        armToken: 0,
        started: true,
        downloadId,
        onComplete(id) {
          if (id !== downloadId) return;
          clearInterval(poll);
          activeDownload = null;
          resolve(true);
        },
        onFailed(id, error) {
          if (id !== downloadId) return;
          clearInterval(poll);
          activeDownload = null;
          reject(new Error(error || "Descarga interrumpida."));
        }
      };
    });
  }

  async function downloadGeneratedImage(img, prompt, token) {
    assertActive(token);

    state.status = "Imagen lista · descargando directamente…";
    state.statusKind = "running";
    scheduleRender();

    let source = null;
    try {
      source = await imageToDownloadableUrl(img, token);

      const result = await chrome.runtime.sendMessage({
        type:"DIRECT_IMAGE_DOWNLOAD",
        prompt,
        folder:state.settings.downloadFolder,
        url:source.url,
        ext:source.ext
      });

      if (!result?.ok || !result.downloadId) {
        throw new Error(result?.error || "Chrome no pudo iniciar la descarga directa.");
      }

      await waitForDirectDownloadComplete(result.downloadId, token);
      return true;
    } finally {
      if (source?.revoke && source.url) {
        setTimeout(() => {
          try { URL.revokeObjectURL(source.url); } catch {}
        }, 5000);
      }
    }
  }

  async function processPrompt(item, token) {
    // Una cola recuperada puede contener pendientes con todos los intentos consumidos.
    // Deben salir de pendientes para que runQueue no repita una Promise vacía sin ceder.
    if (item.attempts >= state.settings.maxAttempts) {
      item.status = "failed";
      item.lastError ||= "Se alcanzó el máximo de intentos. Usa Reintentar fallidos.";
      await saveState();
      scheduleRender();
      return;
    }
    while (item.attempts < state.settings.maxAttempts) {
      assertActive(token);

      item.attempts++;
      item.status = "running";
      item.lastError = "";
      state.currentId = item.id;
      state.status = `Generando · intento ${item.attempts}/${state.settings.maxAttempts}`;
      state.statusKind = "running";
      await saveState();
      scheduleRender();

      try {
        const before = snapshotImages();
        await submitPrompt(buildFinalPrompt(item.prompt), token);

        state.status = "Esperando la imagen nueva…";
        scheduleRender();

        const image = await waitForNewImage(before, token);

        state.status = "Imagen detectada. Preparando descarga…";
        scheduleRender();

        await downloadGeneratedImage(image, item.prompt, token);

        item.status = "done";
        item.lastError = "";
        state.currentId = null;
        state.status = "Completado";
        state.statusKind = "ok";
        await saveState();
        scheduleRender();

        // Espera posterior realmente interrumpible.
        for (let s = state.settings.waitSeconds; s > 0; s--) {
          assertActive(token);
          state.status = `Siguiente prompt en ${s} s`;
          const statusEl = document.querySelector("#cpq-status-text");
          if (statusEl) statusEl.textContent = state.status;
          if (s === state.settings.waitSeconds || s === 1 || s % 5 === 0) await saveState();
          await interruptibleSleep(1000, token);
        }

        return;
      } catch (err) {
        await chrome.runtime.sendMessage({type:"DISARM_DOWNLOAD"}).catch(()=>{});
        activeDownload = null;

        if (err instanceof InterruptedError) {
          // Pausa/detener: no consumir intento.
          item.status = "pending";
          item.attempts = Math.max(0, item.attempts - 1);
          item.lastError = "";
          state.currentId = null;
          await saveState();
          scheduleRender();
          throw err;
        }

        item.lastError = String(err?.message || err || "Error");
        state.currentId = null;

        if (item.attempts < state.settings.maxAttempts) {
          item.status = "running";
          state.status = `Intento ${item.attempts} falló. Reintentando el MISMO prompt…`;
          state.statusKind = "error";
          await saveState();
          scheduleRender();

          await interruptibleSleep(state.settings.retryDelaySeconds * 1000, token);
          continue;
        }

        item.status = "failed";
        state.status = `Fallido tras ${item.attempts}/${state.settings.maxAttempts} intentos`;
        state.statusKind = "error";
        await saveState();
        scheduleRender();
        return;
      }
    }
  }

  async function runQueue(token) {
    try {
      while (isSessionActive(token)) {
        const next = state.items.find(x => x.status === "pending");

        if (!next) {
          state.running = false;
          state.paused = false;
          state.currentId = null;
          const st = stats();
          state.status = st.failed
            ? `Cola terminada · ${st.done} hechos · ${st.failed} fallidos`
            : `Cola terminada · ${st.done}/${st.total}`;
          state.statusKind = st.failed ? "error" : "ok";
          await saveState();
          scheduleRender();
          return;
        }

        await processPrompt(next, token);
      }
    } catch (err) {
      if (!(err instanceof InterruptedError)) {
        console.error("[CPQ]", err);
        state.running = false;
        state.currentId = null;
        state.status = "Error interno de la extensión";
        state.statusKind = "error";
        await saveState();
        scheduleRender();
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "DOWNLOAD_STARTED" && activeDownload?.armToken === msg.token) {
      activeDownload.onStarted?.(msg.downloadId);
    }
    if (msg?.type === "DOWNLOAD_COMPLETE" &&
        (activeDownload?.downloadId === msg.downloadId || activeDownload?.armToken === msg.token)) {
      activeDownload.onComplete?.(msg.downloadId);
    }
    if (msg?.type === "DOWNLOAD_FAILED" &&
        (activeDownload?.downloadId === msg.downloadId || activeDownload?.armToken === msg.token)) {
      activeDownload.onFailed?.(msg.downloadId, msg.error);
    }
    if (msg?.type === "TOGGLE_PANEL" || msg?.type === "SHOW_PANEL") {
      ready.then(() => {
        const missing = !document.querySelector("#cpq-root");
        mount();
        state.panelVisible = msg.type === "SHOW_PANEL" || missing ? true : !state.panelVisible;
        render();
        saveState().catch(error => console.error("[CPQ] No se pudo guardar", error));
        sendResponse({ok:true});
      }).catch(error => sendResponse({ok:false, error:String(error?.message || error)}));
      return true;
    }
  });

  const guardian = new MutationObserver(() => {
    if (!document.querySelector("#cpq-root")) {
      mount();
      scheduleRender();
    }
  });

  const ready = (async () => {
    try {
      await loadState();
    } catch (error) {
      console.error("[CPQ] No se pudo recuperar el estado", error);
      state = structuredClone(DEFAULT);
      state.status = "No se pudo recuperar la cola guardada. Recarga la página para reintentarlo.";
      state.statusKind = "error";
    }
    mount();
    scheduleRender();
    guardian.observe(document.body || document.documentElement, {childList:true});
  })();
  ready.catch(error => {
    window.__CPQ_V2__ = false;
    console.error("[CPQ] No se pudo iniciar el panel", error);
  });
})();
