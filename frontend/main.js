// ==== MONACO (ESM) =========================================================
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
// Importar marked para markdown
import { marked } from 'https://cdnjs.cloudflare.com/ajax/libs/marked/16.2.1/lib/marked.esm.js';

// ==== NAVEGACIÓN DE TABS ==================================================
function showTab(tabName) {
  // Mapear nombres cortos a IDs completos
  const tabMap = {
    'chat': 'panel-chat',
    'editor': 'panel-editor', 
    'config': 'panel-config',
    'plots': 'panel-plots'
  };
  
  const targetId = tabMap[tabName] || tabName;
  
  // Usar el mismo mecanismo que el HTML
  const sidebarIcons = document.querySelectorAll('.sidebar-icon');
  const panels = document.querySelectorAll('.panel');
  
  sidebarIcons.forEach(icon => {
    const on = icon.dataset.target === targetId;
    icon.classList.toggle('active', on);
  });
  
  panels.forEach(p => {
    const on = p.id === targetId;
    p.classList.toggle('active', on);
  });
  
  // Disparar evento para editor si es necesario
  if (targetId === 'panel-editor') {
    window.dispatchEvent(new CustomEvent('editor:visible'));
    setTimeout(() => {
      if (window.updateFileTabsVisibility) {
        window.updateFileTabsVisibility();
      }
    }, 50);
  }
}

// Hacer showTab global
window.showTab = showTab;

self.MonacoEnvironment = {
  getWorker(workerId, label) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
    }
    return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
  },
};

// Lenguaje "spice" básico
monaco.languages.register({ id: 'spice' });
monaco.languages.setMonarchTokensProvider('spice', {
  tokenizer: {
    root: [
      [/\*.*/, 'comment'],
      [/\.(ac|tran|dc|print|include|subckt|ends)\b/i, 'keyword'],
      [/^[RCLVDIQMXY]\w*/i, 'type.identifier'],
      [/\b[0-9]*\.?[0-9]+([eE][+-]?\d+)?[kmunpf]?\b/, 'number'],
    ],
  },
});

// ==== UI/APP ===============================================================
const BACKEND = 'http://localhost:8000'; // ajusta si cambias puerto/host

// Elementos del Chat
const chatBox = document.getElementById('chat');
const askBtn  = document.getElementById('send');
const runBtn  = document.getElementById('run');
const modelSel = document.getElementById('model');
const inputEl = document.getElementById('question');

// Elementos del Editor
const fileTabsContainer = document.getElementById('file-tabs');
const editorConsole = document.getElementById('editor-console');
const consoleContent = document.getElementById('console-content');
let openFiles = new Map(); // filename -> content
let activeFile = null;

// Configuración
let config = {
  model: 'deepseek/deepseek-chat-v3.1:free',
  autoSimulate: false,
  showPlots: true,
  editorTheme: 'vs-dark'
};

function append(role, text, isMarkdown = false) {
  if (!chatBox) return;
  const div = document.createElement('div');
  
  if (isMarkdown) {
    div.innerHTML = `<b>${role}:</b> <div style="margin:6px 0">${marked(text)}</div>`;
  } else {
    div.innerHTML = `<b>${role}:</b> <pre style="white-space:pre-wrap;margin:6px 0">${text}</pre>`;
  }
  
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

// ==== CONSOLE FUNCTIONS ====================================================

function showConsole() {
  if (editorConsole) {
    editorConsole.classList.add('show');
  }
}

function hideConsole() {
  if (editorConsole) {
    editorConsole.classList.remove('show');
  }
}

function clearConsole() {
  if (consoleContent) {
    consoleContent.textContent = '';
  }
}

function appendToConsole(text, type = 'info') {
  if (!consoleContent) return;
  
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${text}\n`;
  
  const span = document.createElement('span');
  span.textContent = line;
  
  if (type === 'error') {
    span.style.color = '#ff6b6b';
  } else if (type === 'success') {
    span.style.color = '#51cf66';
  } else if (type === 'warning') {
    span.style.color = '#ffd43b';
  }
  
  consoleContent.appendChild(span);
  consoleContent.scrollTop = consoleContent.scrollHeight;
}

// ==== GRÁFICOS ============================================================

let simulationChart = null;
let currentData = null; // Almacenar datos actuales para regenerar gráfico

// Configuración por defecto del gráfico
let chartConfig = {
  xScale: 'logarithmic',  // Por defecto logarítmica para frecuencia
  yScale: 'linear',
  chartType: 'line',
  lineColor: '#0e639c',
  lineWidth: 2,
  chartHeight: 400,
  showGrid: true,
  showPoints: false,
  enableAnimations: true
};

function clearPlots() {
  const plotsContainer = document.getElementById('plots-container');
  const noPlotMessage = document.getElementById('no-plots-message');
  
  if (plotsContainer) plotsContainer.style.display = 'none';
  if (noPlotMessage) noPlotMessage.style.display = 'block';
  
  if (simulationChart) {
    simulationChart.destroy();
    simulationChart = null;
  }
  
  currentData = null;
}

function exportPlot() {
  if (simulationChart) {
    const link = document.createElement('a');
    link.download = 'simulation_plot.png';
    link.href = simulationChart.toBase64Image();
    link.click();
  }
}

function hidePlots() {
  const plotsContainer = document.getElementById('plots-container');
  const noPlotMessage = document.getElementById('no-plots-message');
  
  if (plotsContainer) plotsContainer.style.display = 'none';
  if (noPlotMessage) noPlotMessage.style.display = 'block';
}

function toggleControls() {
  const controls = document.getElementById('plot-controls');
  const btn = document.getElementById('toggle-controls');
  
  if (controls.style.display === 'none') {
    controls.style.display = 'block';
    btn.textContent = '🔼 Ocultar';
  } else {
    controls.style.display = 'none';
    btn.textContent = '⚙️ Controles';
  }
}

function createChart(xData, yData, title, xLabel, yLabel) {
  // Registrar plugin de zoom si no está registrado
  if (typeof Chart !== 'undefined' && typeof zoomPlugin !== 'undefined') {
    Chart.register(zoomPlugin);
  }
  
  const canvas = document.getElementById('main-plot-canvas');
  if (!canvas) return;
  
  // Destruir gráfico anterior si existe
  if (simulationChart) {
    simulationChart.destroy();
  }
  
  // Detectar si debería ser logarítmica por defecto
  let defaultXScale = 'linear';
  if (xLabel.toLowerCase().includes('frequency') || (xData.length > 1 && xData[xData.length-1] / xData[0] > 100)) {
    defaultXScale = 'logarithmic';
  }
  
  // Usar configuración por defecto si no está establecida
  if (chartConfig.xScale === 'logarithmic' && defaultXScale === 'logarithmic') {
    document.getElementById('x-scale').value = 'logarithmic';
  }
  
  const ctx = canvas.getContext('2d');
  
  // Configuración de Chart.js
  const chartOptions = {
    type: chartConfig.chartType,
    data: {
      labels: xData,
      datasets: [{
        label: yLabel,
        data: yData,
        borderColor: chartConfig.lineColor,
        backgroundColor: chartConfig.lineColor + '20', // Color con transparencia
        borderWidth: chartConfig.lineWidth,
        pointRadius: chartConfig.showPoints ? 3 : 0,
        pointHoverRadius: 5,
        fill: false,
        tension: chartConfig.chartType === 'line' ? 0.1 : 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: chartConfig.enableAnimations,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        title: {
          display: true,
          text: title,
          color: '#333',
          font: {
            size: 16,
            weight: 'bold'
          }
        },
        legend: {
          labels: {
            color: '#333'
          }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'xy'
          },
          zoom: {
            wheel: {
              enabled: true
            },
            pinch: {
              enabled: true
            },
            mode: 'xy'
          }
        }
      },
      scales: {
        x: {
          type: chartConfig.xScale,
          display: true,
          title: {
            display: true,
            text: xLabel,
            color: '#333',
            font: {
              size: 14,
              weight: 'bold'
            }
          },
          grid: {
            display: chartConfig.showGrid,
            color: '#e0e0e0'
          },
          ticks: {
            color: '#666'
          }
        },
        y: {
          type: chartConfig.yScale,
          display: true,
          title: {
            display: true,
            text: yLabel,
            color: '#333',
            font: {
              size: 14,
              weight: 'bold'
            }
          },
          grid: {
            display: chartConfig.showGrid,
            color: '#e0e0e0'
          },
          ticks: {
            color: '#666'
          }
        }
      },
      plugins: {
        zoom: {
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true
            },
            mode: 'xy',
            scaleMode: 'xy'
          },
          pan: {
            enabled: true,
            mode: 'xy'
          }
        }
      }
    }
  };
  
  simulationChart = new Chart(ctx, chartOptions);
  window.currentChart = simulationChart;
}

function showChart(xData, yData, title = 'Simulación ngspice', xLabel = 'X', yLabel = 'Y') {
  // Cambiar a la pestaña de gráficos
  showTab('plots');
  
  const plotsContainer = document.getElementById('plots-container');
  const noPlotMessage = document.getElementById('no-plots-message');
  const plotTitle = document.getElementById('plot-title');
  
  if (!plotsContainer || !noPlotMessage || !plotTitle) return;
  
  // Mostrar contenedor de gráficos y ocultar mensaje de "no hay gráficos"
  plotsContainer.style.display = 'block';
  noPlotMessage.style.display = 'none';
  
  // Actualizar título
  plotTitle.textContent = title;
  
  // Almacenar datos actuales
  currentData = { xData, yData, title, xLabel, yLabel };
  
  // Detectar tipo de análisis basado en los datos solo si no se proporcionaron etiquetas
  if (xLabel === 'X' && yLabel === 'Y' && xData.length > 0) {
    if (xData[0] < 1e-6) {
      xLabel = 'Tiempo (s)';
      yLabel = 'Voltaje (V)';
      chartConfig.xScale = 'linear';
    } else if (xData[0] > 1) {
      xLabel = 'Frecuencia (Hz)';
      yLabel = 'Magnitud (dB)';
      chartConfig.xScale = 'logarithmic';
    }
    currentData.xLabel = xLabel;
    currentData.yLabel = yLabel;
  }
  
  // Crear el gráfico
  createChart(xData, yData, title, xLabel, yLabel);
}

// ==== CONFIGURACIÓN ========================================================

// ==== CONFIGURACIÓN ========================================================

function loadConfig() {
  const saved = localStorage.getItem('spice-llm-config');
  if (saved) {
    config = { ...config, ...JSON.parse(saved) };
  }
  updateConfigUI();
}

function saveConfig() {
  localStorage.setItem('spice-llm-config', JSON.stringify(config));
  updateConfigUI();
  
  // Aplicar cambios inmediatamente
  if (editor && config.editorTheme) {
    monaco.editor.setTheme(config.editorTheme);
  }
  
  // Actualizar select del modelo en el chat
  if (modelSel) {
    modelSel.value = config.model;
  }
}

function updateConfigUI() {
  const configModel = document.getElementById('config-model');
  const autoSimulate = document.getElementById('auto-simulate');
  const showPlots = document.getElementById('show-plots');
  const editorTheme = document.getElementById('editor-theme');
  
  if (configModel) configModel.value = config.model;
  if (autoSimulate) autoSimulate.checked = config.autoSimulate;
  if (showPlots) showPlots.checked = config.showPlots;
  if (editorTheme) editorTheme.value = config.editorTheme;
}

// ==== FILE MANAGEMENT ======================================================

async function loadFileList() {
  try {
    const response = await fetch(`${BACKEND}/files`);
    const data = await response.json();
    return data.files || [];
  } catch (e) {
    console.error('Error loading file list:', e);
    return [];
  }
}

async function loadFileContent(filename) {
  try {
    const response = await fetch(`${BACKEND}/files/${filename}`);
    const data = await response.json();
    return data.content || '';
  } catch (e) {
    console.error('Error loading file content:', e);
    return '';
  }
}

async function saveFileContent(filename, content) {
  try {
    const response = await fetch(`${BACKEND}/files/${filename}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    return await response.json();
  } catch (e) {
    console.error('Error saving file:', e);
    return { error: e.message };
  }
}

function createFileTab(filename, isActive = false) {
  const tab = document.createElement('div');
  tab.className = `file-tab ${isActive ? 'active' : ''}`;
  tab.dataset.filename = filename;
  
  tab.innerHTML = `
    <span>${filename}</span>
    <span class="close" onclick="closeFile('${filename}')">&times;</span>
  `;
  
  tab.addEventListener('click', (e) => {
    if (!e.target.classList.contains('close')) {
      switchToFile(filename);
    }
  });
  
  return tab;
}

async function openFile(filename) {
  console.log('Opening file:', filename);
  if (openFiles.has(filename)) {
    switchToFile(filename);
    return;
  }
  
  const content = await loadFileContent(filename);
  openFiles.set(filename, content);
  
  const tab = createFileTab(filename, true);
  fileTabsContainer.appendChild(tab);
  console.log('Tab added to container:', fileTabsContainer);
  
  switchToFile(filename);
  updateFileTabsVisibility();
}

function switchToFile(filename) {
  if (!openFiles.has(filename)) return;
  
  // Actualizar tabs activos
  document.querySelectorAll('.file-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.filename === filename);
  });
  
  // Actualizar editor
  activeFile = filename;
  createEditorOnce();
  if (editor) {
    editor.setValue(openFiles.get(filename));
  }
  
  // Actualizar información del archivo
  updateFileInfo();
  updateFileTabsVisibility();
}

function closeFile(filename) {
  openFiles.delete(filename);
  
  const tab = document.querySelector(`[data-filename="${filename}"]`);
  if (tab) {
    tab.remove();
  }
  
  // Si era el archivo activo, cambiar a otro
  if (activeFile === filename) {
    const remainingFiles = Array.from(openFiles.keys());
    if (remainingFiles.length > 0) {
      switchToFile(remainingFiles[0]);
    } else {
      activeFile = null;
      if (editor) {
        editor.setValue('// No hay archivos abiertos');
      }
      updateFileInfo();
    }
  }
  updateFileTabsVisibility();
}

function updateFileInfo() {
  const fileInfoEl = document.getElementById('file-info');
  if (fileInfoEl) {
    if (activeFile) {
      fileInfoEl.textContent = `📄 ${activeFile}`;
      fileInfoEl.style.opacity = '1';
    } else {
      fileInfoEl.textContent = 'Sin archivo activo';
      fileInfoEl.style.opacity = '0.7';
    }
  }
  
  // Actualizar estado del botón de simular
  const runBtn = document.getElementById('run');
  if (runBtn) {
    if (activeFile) {
      runBtn.disabled = false;
      runBtn.style.opacity = '1';
      runBtn.title = `Simular ${activeFile}`;
    } else {
      runBtn.disabled = true;
      runBtn.style.opacity = '0.5';
      runBtn.title = 'Selecciona un archivo para simular';
    }
  }
}

async function refreshFileList() {
  const files = await loadFileList();
  console.log('Available files:', files.length);
  
  // Si no hay archivos abiertos, abrir los 3 más recientes
  if (openFiles.size === 0 && files.length > 0) {
    const filesToOpen = files.slice(0, Math.min(3, files.length));
    console.log('Opening files:', filesToOpen.map(f => f.name));
    
    for (const file of filesToOpen) {
      await openFile(file.name);
    }
    
    // Activar el primer archivo (más reciente)
    if (filesToOpen.length > 0) {
      switchToFile(filesToOpen[0].name);
    }
  }
  
  // Actualizar la visibilidad de las pestañas
  updateFileTabsVisibility();
}

function updateFileTabsVisibility() {
  // Las pestañas ahora están dentro del panel del editor, 
  // por lo que se muestran/ocultan automáticamente con el panel
  console.log('Tabs are inside editor panel, openFilesCount:', openFiles.size);
}

// ==== LLM CHAT =============================================================

async function callLLMStream(question) {
  const payload = {
    system: 'Eres un asistente de SPICE. Responde en formato markdown cuando sea apropiado. Siempre debes de proporcionar el codigo spice para simular en ngspice.',
    question,
    model: config.model,
    stream: true,
  };
  
  const response = await fetch(`${BACKEND}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) throw new Error(`Backend /chat ${response.status}`);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let botMessage = '';
  let botDiv = null;
  let buffer = '';
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Guardar la línea incompleta para el siguiente chunk
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // Manejar contenido normal del chat
            if (data.content) {
              botMessage += data.content;
              
              // Crear el div del bot si no existe
              if (!botDiv) {
                botDiv = append('Bot', '', true);
              }
              
              // Actualizar el contenido con markdown
              const contentDiv = botDiv.querySelector('div');
              if (contentDiv) {
                contentDiv.innerHTML = marked(botMessage);
              }
              
              chatBox.scrollTop = chatBox.scrollHeight;
            }
            
            // Manejar archivos generados
            if (data.generated_files && data.generated_files.length > 0) {
              const filesDiv = append('📄 Netlists Generados', '', true);
              const contentDiv = filesDiv.querySelector('div');
              
              let filesHTML = '<div class="generated-files">';
              for (const filename of data.generated_files) {
                filesHTML += `<span class="netlist-link" onclick="openGeneratedFile('${filename}')">${filename}</span> `;
              }
              filesHTML += '</div>';
              
              contentDiv.innerHTML = filesHTML;
              
              // Refrescar la lista de archivos
              refreshFileList();
              
              chatBox.scrollTop = chatBox.scrollHeight;
            }
            
          } catch (e) {
            // Ignorar errores de parsing
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  return botMessage;
}

async function onAsk() {
  let q = inputEl ? inputEl.value.trim() : '';
  if (!q) {
    // si no hay input en el HTML, pedimos por prompt()
    q = window.prompt('Escribe tu pregunta para el LLM:') || '';
    q = q.trim();
  }
  if (!q) return;

  if (inputEl) inputEl.value = '';
  append('Tú', q);

  try {
    const resp = await callLLMStream(q);

    // Después de completar la respuesta, actualizar la lista de archivos
    setTimeout(async () => {
      await refreshFileList();
      
      // Si se generaron archivos, abrir el más reciente
      const files = await loadFileList();
      if (files.length > 0) {
        const newestFile = files[0]; // Ya están ordenados por fecha de modificación
        if (!openFiles.has(newestFile.name)) {
          await openFile(newestFile.name);
        }
      }
    }, 1000); // Esperar 1 segundo para que el backend termine de guardar

  } catch (e) {
    append('Error', String(e.message || e));
  }
}

// ==== SIMULACIÓN NGSPICE ===================================================

async function simulateNetlist(netlist) {
  const r = await fetch(`${BACKEND}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netlist }),
  });
  if (!r.ok) throw new Error(`Backend /simulate ${r.status}`);
  return r.json(); // { ok, logs, x, y }
}

async function onRun() {
  createEditorOnce();
  const net = editor.getValue();
  
  // Mostrar la consola y limpiarla
  showConsole();
  clearConsole();
  
  appendToConsole('Iniciando simulación ngspice...', 'info');
  appendToConsole(`Netlist activo: ${activeFile || 'Sin título'}`, 'info');

  try {
    const data = await simulateNetlist(net);
    
    if (data.ok) {
      appendToConsole('✅ Simulación completada exitosamente', 'success');
    } else {
      appendToConsole('⚠️ Simulación completada con advertencias', 'warning');
    }
    
    // Mostrar logs de ngspice
    if (data.logs) {
      appendToConsole('--- Salida de ngspice ---', 'info');
      appendToConsole(data.logs, 'info');
    }

    // Mostrar datos de plot si existen
    if (data.x?.length && data.y?.length) {
      appendToConsole(`📊 Datos generados: ${data.x.length} puntos`, 'success');
      appendToConsole(`Rango X: ${data.x[0]} → ${data.x[data.x.length-1]}`, 'info');
      appendToConsole(`Rango Y: ${Math.min(...data.y)} → ${Math.max(...data.y)}`, 'info');
      
      // Mostrar gráfico si está habilitado en la configuración
      if (config.showPlots) {
        const title = data.plot_title || `Simulación ${activeFile || 'Sin título'}`;
        const xLabel = data.x_label || 'X';
        const yLabel = data.y_label || 'Y';
        showChart(data.x, data.y, title, xLabel, yLabel);
        appendToConsole('📈 Gráfico generado - Ver pestaña "Gráficos" 📊', 'success');
      } else {
        appendToConsole('💡 Tip: Habilita "Mostrar gráficos" en configuración para ver el gráfico', 'info');
      }
      
      // También mostrar en el chat si está configurado
      if (config.showPlots) {
        append('📊 Gráfico', `Puntos: ${data.x.length} (ej: x[0]=${data.x[0]}, y[0]=${data.y[0]})`);
      }
    } else if (data.x?.length) {
      appendToConsole('⚠️ Se encontraron datos X pero no datos Y', 'warning');
    }
    
  } catch (e) {
    appendToConsole(`❌ Error en simulación: ${e.message}`, 'error');
    append('Error', String(e.message || e));
  }
}

// Bind botones si existen
if (askBtn) askBtn.addEventListener('click', onAsk);
if (runBtn) runBtn.addEventListener('click', onRun);

// Configuración
const saveConfigBtn = document.getElementById('save-config');
if (saveConfigBtn) {
  saveConfigBtn.addEventListener('click', () => {
    // Leer valores de la UI
    const configModel = document.getElementById('config-model');
    const autoSimulate = document.getElementById('auto-simulate');
    const showPlots = document.getElementById('show-plots');
    const editorTheme = document.getElementById('editor-theme');
    
    if (configModel) config.model = configModel.value;
    if (autoSimulate) config.autoSimulate = autoSimulate.checked;
    if (showPlots) config.showPlots = showPlots.checked;
    if (editorTheme) config.editorTheme = editorTheme.value;
    
    saveConfig();
    alert('Configuración guardada');
  });
}

// Botón para abrir más archivos
const openMoreFilesBtn = document.getElementById('open-more-files');
if (openMoreFilesBtn) {
  openMoreFilesBtn.addEventListener('click', async () => {
    const files = await loadFileList();
    if (files.length === 0) {
      alert('No hay archivos disponibles');
      return;
    }
    
    // Mostrar archivos que no están abiertos
    const unopenedFiles = files.filter(f => !openFiles.has(f.name));
    if (unopenedFiles.length === 0) {
      alert('Todos los archivos ya están abiertos');
      return;
    }
    
    const fileNames = unopenedFiles.map(f => f.name);
    const choice = prompt(`Archivos disponibles:\n${fileNames.join('\n')}\n\nEscribe el nombre del archivo a abrir:`);
    
    if (choice && fileNames.includes(choice)) {
      await openFile(choice);
    }
  });
}

// Permite Enter en el input opcional
if (inputEl) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAsk();
  });
}

// Event listeners para botones de consola y gráfico
const clearConsoleBtn = document.getElementById('clear-console');
const toggleConsoleBtn = document.getElementById('toggle-console');
const hideChartBtn = document.getElementById('hide-chart');

if (clearConsoleBtn) {
  clearConsoleBtn.addEventListener('click', clearConsole);
}

if (toggleConsoleBtn) {
  toggleConsoleBtn.addEventListener('click', () => {
    const console = document.getElementById('editor-console');
    if (console) {
      console.classList.toggle('show');
      toggleConsoleBtn.textContent = console.classList.contains('show') ? 'Ocultar' : 'Mostrar';
    }
  });
}

// Event listeners para botones de gráficos
const clearPlotsBtn = document.getElementById('clear-plots');
const exportPlotBtn = document.getElementById('export-plot');
const resetZoomBtn = document.getElementById('reset-zoom');
const toggleControlsBtn = document.getElementById('toggle-controls');
const applyChangesBtn = document.getElementById('apply-changes');

// Event listeners para controles de gráfico
const xScaleSelect = document.getElementById('x-scale');
const yScaleSelect = document.getElementById('y-scale');
const chartTypeSelect = document.getElementById('chart-type');
const lineColorInput = document.getElementById('line-color');
const colorPresetSelect = document.getElementById('color-preset');
const chartHeightSelect = document.getElementById('chart-height');
const lineWidthInput = document.getElementById('line-width');
const lineWidthValue = document.getElementById('line-width-value');

if (clearPlotsBtn) {
  clearPlotsBtn.addEventListener('click', clearPlots);
}

if (exportPlotBtn) {
  exportPlotBtn.addEventListener('click', exportPlot);
}

if (resetZoomBtn) {
  resetZoomBtn.addEventListener('click', () => {
    if (simulationChart) {
      simulationChart.resetZoom();
    }
  });
}

if (toggleControlsBtn) {
  toggleControlsBtn.addEventListener('click', toggleControls);
}

if (applyChangesBtn) {
  applyChangesBtn.addEventListener('click', applyChartChanges);
}

// Event listeners para cambios automáticos
if (colorPresetSelect) {
  colorPresetSelect.addEventListener('change', (e) => {
    const colorInput = document.getElementById('line-color');
    if (colorInput) {
      colorInput.value = e.target.value;
    }
  });
}

if (lineWidthInput && lineWidthValue) {
  lineWidthInput.addEventListener('input', (e) => {
    lineWidthValue.textContent = e.target.value;
  });
}

// Auto-aplicar algunos cambios
if (chartHeightSelect) {
  chartHeightSelect.addEventListener('change', updateChartSize);
}

// ==== MONACO: crear solo cuando el panel Editor sea visible =================
let editor;
let editorCreated = false;

function createEditorOnce() {
  if (editorCreated) {
    editor?.layout();
    return;
  }
  editorCreated = true;

  editor = monaco.editor.create(document.getElementById('editor'), {
    value: `* RC LPF
Vin in 0 AC 1
R1 in out 1k
C1 out 0 159n
.ac dec 20 10 1e6
.print ac freq vm(out)
.end`,
    language: 'spice',
    theme: config.editorTheme,
    automaticLayout: true,
    minimap: { enabled: false },
  });
}

// por si ya estás en la pestaña Editor al cargar
if (document.getElementById('panel-editor')?.classList.contains('active')) {
  createEditorOnce();
  refreshFileList();
}

// escucha el evento que dispara tu index.html al cambiar de pestaña
window.addEventListener('editor:visible', async () => {
  createEditorOnce();
  await refreshFileList();
  updateFileTabsVisibility();
});

// Hacer closeFile global para el onclick del HTML
window.closeFile = closeFile;
window.updateFileTabsVisibility = updateFileTabsVisibility;

// HMR-friendly (Vite)
if (import.meta.hot) {
  import.meta.hot.dispose(() => editor?.dispose());
}

// Cargar configuración al inicio
loadConfig();

// Inicializar información del archivo
updateFileInfo();

// Función para abrir archivos generados
async function openGeneratedFile(filename) {
  try {
    // Cambiar a la pestaña del editor
    showTab('editor');
    
    // Cargar el archivo
    await openFile(filename);
    
    // Mostrar mensaje en la consola
    showConsole();
    appendToConsole(`📂 Archivo cargado: ${filename}`, 'success');
    appendToConsole('💡 Tip: Presiona el botón "Simular" para ejecutar este netlist', 'info');
    
  } catch (error) {
    console.error('Error opening generated file:', error);
    appendToConsole(`❌ Error cargando archivo: ${filename}`, 'error');
  }
}

// Hacer la función global para el onclick del HTML
window.openGeneratedFile = openGeneratedFile;

// ============= FUNCIONES DE CONTROL DE GRÁFICOS =============

// Función para actualizar el tamaño del gráfico
function updateChartSize() {
  const chartHeightSelect = document.getElementById('chart-height');
  const chartContainer = document.getElementById('chart-container');
  
  if (chartHeightSelect && chartContainer) {
    const newHeight = chartHeightSelect.value + 'px';
    chartContainer.style.height = newHeight;
    
    if (window.currentChart) {
      window.currentChart.resize();
    }
  }
}

// Función para aplicar todos los cambios del gráfico
function applyChartChanges() {
  if (!window.currentChart) return;
  
  // Aplicar configuración actual
  const chart = window.currentChart;
  
  // Actualizar tipo de gráfico
  chart.config.type = chartConfig.chartType;
  
  // Actualizar escalas
  chart.config.options.scales.x.type = chartConfig.xScale;
  chart.config.options.scales.y.type = chartConfig.yScale;
  
  // Actualizar colores y estilos
  if (chart.data.datasets[0]) {
    chart.data.datasets[0].borderColor = chartConfig.lineColor;
    chart.data.datasets[0].backgroundColor = chartConfig.lineColor + '20'; // semi-transparente
    chart.data.datasets[0].borderWidth = chartConfig.lineWidth;
    chart.data.datasets[0].pointRadius = chartConfig.showPoints ? 3 : 0;
  }
  
  // Actualizar grid
  chart.config.options.scales.x.grid.display = chartConfig.showGrid;
  chart.config.options.scales.y.grid.display = chartConfig.showGrid;
  
  // Actualizar animaciones
  chart.config.options.animation = chartConfig.enableAnimations;
  
  // Actualizar el gráfico
  chart.update();
  
  appendToConsole('✅ Configuración del gráfico aplicada', 'success');
}

// Función para resetear zoom
function resetChartZoom() {
  if (window.currentChart && window.currentChart.resetZoom) {
    window.currentChart.resetZoom();
    appendToConsole('🔍 Zoom del gráfico reseteado', 'info');
  }
}

// Función para exportar gráfico
function exportChart() {
  if (!window.currentChart) {
    appendToConsole('❌ No hay gráfico para exportar', 'error');
    return;
  }
  
  try {
    const chart = window.currentChart;
    const url = chart.toBase64Image('image/png', 1.0);
    
    // Crear enlace de descarga
    const link = document.createElement('a');
    link.download = `spice_plot_${Date.now()}.png`;
    link.href = url;
    link.click();
    
    appendToConsole('📥 Gráfico exportado exitosamente', 'success');
  } catch (error) {
    console.error('Error exporting chart:', error);
    appendToConsole('❌ Error exportando gráfico', 'error');
  }
}

// Función para limpiar gráfico
function clearChart() {
  const chartContainer = document.getElementById('chart-container');
  if (chartContainer) {
    chartContainer.innerHTML = '<canvas id="simulationChart"></canvas>';
    window.currentChart = null;
    appendToConsole('🗑️ Gráfico limpiado', 'info');
  }
}

// Función para alternar controles
function toggleChartControls() {
  const controls = document.getElementById('plot-controls');
  const toggleBtn = document.getElementById('toggle-controls');
  
  if (controls && toggleBtn) {
    const isHidden = controls.style.display === 'none';
    controls.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? '🔼 Ocultar Controles' : '🔽 Mostrar Controles';
  }
}

// Función para guardar configuración
function saveChartConfig() {
  try {
    localStorage.setItem('spice_chart_config', JSON.stringify(chartConfig));
    appendToConsole('💾 Configuración del gráfico guardada', 'success');
  } catch (error) {
    console.error('Error saving config:', error);
    appendToConsole('❌ Error guardando configuración', 'error');
  }
}

// Función para cargar configuración
function loadChartConfig() {
  try {
    const saved = localStorage.getItem('spice_chart_config');
    if (saved) {
      const savedConfig = JSON.parse(saved);
      Object.assign(chartConfig, savedConfig);
      
      // Aplicar a los controles UI
      updateControlsFromConfig();
      appendToConsole('📂 Configuración del gráfico cargada', 'success');
    }
  } catch (error) {
    console.error('Error loading config:', error);
    appendToConsole('❌ Error cargando configuración', 'error');
  }
}

// Función para actualizar controles desde configuración
function updateControlsFromConfig() {
  const elements = {
    'x-scale': chartConfig.xScale,
    'y-scale': chartConfig.yScale,
    'chart-type': chartConfig.chartType,
    'line-color': chartConfig.lineColor,
    'line-width': chartConfig.lineWidth,
    'chart-height': chartConfig.chartHeight,
    'show-points': chartConfig.showPoints,
    'show-grid': chartConfig.showGrid,
    'enable-animations': chartConfig.enableAnimations
  };
  
  for (const [id, value] of Object.entries(elements)) {
    const element = document.getElementById(id);
    if (element) {
      if (element.type === 'checkbox') {
        element.checked = value;
      } else {
        element.value = value;
      }
    }
  }
}

// Hacer funciones globales
window.updateChartSize = updateChartSize;
window.applyChartChanges = applyChartChanges;
window.resetChartZoom = resetChartZoom;
window.exportChart = exportChart;
window.clearChart = clearChart;
window.toggleChartControls = toggleChartControls;
window.saveChartConfig = saveChartConfig;
window.loadChartConfig = loadChartConfig;

// Cargar configuración al inicializar
document.addEventListener('DOMContentLoaded', loadChartConfig);
