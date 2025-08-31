import * as monaco from 'monaco-editor';

const editor = monaco.editor.create(document.getElementById('editor'), {
  value: `* RC LPF - ejemplo AC\nVin in 0 AC 1\nR1 in out 1k\nC1 out 0 159n\n.ac dec 20 10 1e6\n.print ac freq vm(out)\n.end`,
  language: 'plaintext',
  theme: 'vs-dark',
  automaticLayout: true
});

const chat = document.getElementById('chat');
const btnAsk = document.getElementById('ask');
const btnRun = document.getElementById('run');
const modelSel = document.getElementById('model');

const BACKEND = "http://localhost:8000";

function append(role, html) {
  const d = document.createElement('div');
  d.innerHTML = `<b>${role}:</b> ${html}`;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

btnAsk.onclick = async () => {
  const user = `Genera un netlist SPICE de un filtro pasa-bajos RC con fc≈1kHz.\nIncluye .ac y .print ac freq vm(out).`;
  append("Tú", `<pre>${user}</pre>`);
  const r = await fetch(`${BACKEND}/chat`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      system: "Eres un asistente que genera netlists SPICE válidos.",
      user,
      model: modelSel.value
    })
  });
  const data = await r.json();
  append("Bot", `<pre>${data.content}</pre>`);
  // si la respuesta parece un netlist, ponlo en el editor
  if (typeof data.content === "string" && data.content.includes(".end"))
    editor.setValue(data.content.replace(/^```.*\n?/g, "").replace(/```$/,""));
};

btnRun.onclick = async () => {
  const netlist = editor.getValue();
  append("Acción", "Simulando con ngspice...");
  const r = await fetch(`${BACKEND}/simulate`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ netlist })
  });
  const data = await r.json();
  append("ngspice", `<pre>${(data.logs || "").slice(0, 2000)}</pre>`);
  // Si hay datos x/y (AC o TRAN), muestralos rápido:
  if (data.x?.length) {
    append("Plot", `Puntos: ${data.x.length} (ej: x[0]=${data.x[0]}, y[0]=${data.y[0]})`);
    // Aquí puedes integrar Plotly para graficar bonito.
  }
};
