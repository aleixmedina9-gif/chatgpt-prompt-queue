CHATGPT PROMPT QUEUE v2.0

INSTALACIÓN
1. Descomprime el ZIP.
2. Abre chrome://extensions (o edge://extensions).
3. Activa Modo de desarrollador.
4. Elimina/desactiva versiones antiguas de ChatGPT Prompt Queue.
5. Pulsa Cargar descomprimida y selecciona la carpeta chatgpt_prompt_queue_v2.
6. Abre ChatGPT y recarga la página.

NOVEDADES PRINCIPALES
- Pausa real: invalida inmediatamente el worker y no envía el siguiente prompt.
- Detener real: corta la automatización, desarma el interceptor de descargas y no envía más prompts.
- Máximo de intentos real: el MISMO prompt se vuelve a intentar hasta el valor configurado antes de pasar al siguiente.
- Nombre de archivo: cada imagen se renombra con el texto del prompt.
- Carpeta propia: por defecto Descargas/ChatGPT Prompt Queue/.
- No cambia ninguna preferencia global de Chrome: fuera de una descarga armada por la extensión, Chrome se comporta como siempre.
- Al Detener: exporta automáticamente el mismo .txt original con solo las líneas todavía no completadas.
- Botón manual Exportar pendientes.
- Nueva interfaz futurista/clean con pestaña Configuración.
- Configuración: espera tras descarga, máximo de intentos, espera entre reintentos, timeout de generación, timeout de descarga, carpeta y checkpoint automático.
- La lista visual usa una ventana inteligente para no cargar miles de elementos de golpe.

NOTA
ChatGPT es una web que puede cambiar su DOM. La extensión usa detección heurística de cuadro de texto,
imagen nueva y controles de descarga para tolerar cambios razonables, pero futuras modificaciones grandes
de la interfaz pueden requerir adaptar selectores.


v2.1
- Campo para escribir prompts directamente y botón para añadirlos a la cola.
- Sigue aceptando .txt.
- Prefijo configurable antes de cada prompt (por defecto: Create image:).
- Sufijo configurable.
- El nombre del archivo usa SIEMPRE el prompt original, sin el prefijo/sufijo.
- Presets visuales: modo de imagen, relación de aspecto y calidad/preferencia.
- Idiomas de interfaz: Español, English y Català.
- Descarga más rápida: timeout inicial reducido a 3 s y reintentos internos a 200 ms.
- Carpeta propia de descargas se mantiene.
- Checkpoint TXT al detener se mantiene.


v2.2 DIRECT DOWNLOAD
- Eliminado el sistema que buscaba/pulsaba botones de la tarjeta de imagen.
- Ya NO pulsa Share/Compartir ni otros botones de ChatGPT.
- Ya NO debe abrir get.microsoft.com ni el selector teléfono/ordenador.
- Obtiene la URL/Blob de la imagen generada directamente desde la página.
- Descarga mediante chrome.downloads.download sin abandonar ChatGPT.
- Nombre: prompt original.
- Destino: subcarpeta configurada dentro de Descargas.


v2.3 FORCED NAMES + FOLDER
- Corregida la carrera de eventos de chrome.downloads.
- La extensión registra el nombre deseado ANTES de crear la descarga.
- onDeterminingFilename fuerza siempre:
  Descargas/<carpeta configurada>/<prompt original>.<extensión>
- Ya no depende del nombre aleatorio interno que entregue ChatGPT/CDN.
- La carpeta por defecto sigue siendo: ChatGPT Prompt Queue
- Si existe un archivo con el mismo nombre, Chrome añade (1), (2), etc.
