import os, tempfile, subprocess, json, re, math
from fastapi import FastAPI, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import requests
from dotenv import load_dotenv
from datetime import datetime

load_dotenv()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Directorio para circuitos generados
CIRCUITS_DIR = os.path.join(os.path.dirname(__file__), "circuits_generated")
os.makedirs(CIRCUITS_DIR, exist_ok=True)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ajusta en producción
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/chat")
def chat(payload: dict = Body(...)):
    """
    payload = { "system": "...", "user": "...", "question": "...", "model": "deepseek/deepseek-chat-v3.1:free", "stream": false }
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://ditsolabs.github.io/",   # cuidado, capitalización
        "X-Title": "NGSpice Netlist Generation",
        "Content-Type": "application/json",
    }

    messages = []
    if "system" in payload:
        messages.append({"role": "system", "content": payload["system"]})

    if "user" in payload:
        messages.append({"role": "user", "content": payload["user"]})

    if "question" in payload:
        # 👇 Ojo: lo ideal es que "user" contenga ya la pregunta, o combines ambos campos
        messages.append({"role": "user", "content": payload["question"]})

    is_stream = payload.get("stream", False)
    
    data = {
        "model": payload.get("model", "deepseek/deepseek-chat-v3.1:free"),
        "messages": messages,
        "stream": is_stream,
    }

    if is_stream:
        full_content = ""  # Acumular todo el contenido para procesarlo al final
        
        def generate():
            nonlocal full_content
            with requests.post(OPENROUTER_URL, headers=headers, json=data, stream=True, timeout=120) as r:
                r.raise_for_status()
                r.encoding = 'utf-8'  # Forzar UTF-8
                buffer = ""
                for chunk in r.iter_content(chunk_size=1024, decode_unicode=True):
                    if chunk:
                        buffer += chunk
                        while True:
                            line_end = buffer.find('\n')
                            if line_end == -1:
                                break
                            
                            line = buffer[:line_end].strip()
                            buffer = buffer[line_end + 1:]
                            
                            if line.startswith('data: '):
                                data_content = line[6:]
                                if data_content == '[DONE]':
                                    # Procesar el contenido completo al final
                                    saved_files = save_spice_blocks_from_content(full_content)
                                    # Enviar información sobre archivos generados
                                    if saved_files:
                                        file_info = {"generated_files": saved_files}
                                        yield f"data: {json.dumps(file_info, ensure_ascii=False)}\n\n".encode('utf-8')
                                    return
                                
                                try:
                                    data_obj = json.loads(data_content)
                                    content = data_obj["choices"][0]["delta"].get("content")
                                    if content:
                                        full_content += content  # Acumular contenido
                                        # Asegurar que el contenido esté en UTF-8
                                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n".encode('utf-8')
                                except json.JSONDecodeError:
                                    pass
        
        return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
    else:
        r = requests.post(OPENROUTER_URL, headers=headers, json=data, timeout=120)
        r.raise_for_status()
        response_data = r.json()
        content = response_data["choices"][0]["message"]["content"]
        
        # Extraer y guardar automáticamente bloques SPICE
        saved_files = save_spice_blocks_from_content(content)
        
        # Incluir información de archivos generados en la respuesta
        result = response_data
        if saved_files:
            result["generated_files"] = saved_files
        
        return result


def save_spice_blocks_from_content(content):
    """Extrae bloques SPICE de la respuesta y los guarda automáticamente"""
    saved_files = []
    try:
        # Buscar bloques de código SPICE
        spice_pattern = r'```(?:spice)?\n([\s\S]*?)\n```'
        matches = re.findall(spice_pattern, content, re.IGNORECASE)
        
        for i, spice_code in enumerate(matches):
            if '.end' in spice_code:  # Verificar que sea un netlist válido
                timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                filename = f"generated_{timestamp}_{i+1}.cir"
                filepath = os.path.join(CIRCUITS_DIR, filename)
                
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(spice_code.strip())
                
                saved_files.append(filename)
                
    except Exception as e:
        print(f"Error saving SPICE blocks: {e}")
    
    return saved_files


@app.post("/simulate")
def simulate_spice(body: dict = Body(...)):
    """
    body = { "netlist": "...", "analysis":"ac|tran" }
    Devuelve logs crudos y datos extraídos del archivo rawfile de ngspice.
    """
    net = body["netlist"]
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "circuit.sp")
        log = os.path.join(td, "out.log")
        raw = os.path.join(td, "output.raw")
        
        # Procesar el netlist para generar archivo rawfile
        lines = net.strip().split('\n')
        modified_lines = []
        in_control_block = False
        has_write_command = False
        has_run_command = False
        analysis_commands = []  # Para almacenar comandos de análisis encontrados en .control
        
        for line in lines:
            line_lower = line.lower().strip()
            original_line = line
            
            # Detectar inicio/fin de bloque .control
            if line_lower.startswith('.control'):
                in_control_block = True
                modified_lines.append(original_line)
                continue
            elif line_lower.startswith('.endc'):
                in_control_block = False
                # Asegurar que tenemos run y write antes de cerrar
                if not has_run_command:
                    modified_lines.append('run')
                if not has_write_command:
                    modified_lines.append(f'write {raw}')
                modified_lines.append(original_line)
                continue
            
            # Dentro de bloque .control
            if in_control_block:
                # Detectar comando run existente
                if line_lower.startswith('run'):
                    has_run_command = True
                    modified_lines.append(original_line)
                # Mover comandos de análisis fuera del bloque .control
                elif any(line_lower.startswith(cmd) for cmd in ['ac ', 'tran ', 'dc ', 'op']):
                    # Asegurar que el comando tenga punto al inicio
                    if not original_line.strip().startswith('.'):
                        analysis_commands.append('.' + original_line.strip())
                    else:
                        analysis_commands.append(original_line)
                    continue  # No agregar aquí, se agregará antes del .control
                # Remover comandos plot ya que no funcionan en batch
                elif line_lower.startswith('plot '):
                    continue  # Skip plot commands
                # Detectar comandos write existentes
                elif line_lower.startswith('write '):
                    has_write_command = True
                    modified_lines.append(f'write {raw}')
                else:
                    modified_lines.append(original_line)
            else:
                modified_lines.append(original_line)
        
        # Insertar comandos de análisis antes del bloque .control o antes de .end
        if analysis_commands:
            final_lines = []
            control_inserted = False
            
            for line in modified_lines:
                if line.lower().strip().startswith('.control') and not control_inserted:
                    # Insertar análisis antes del .control
                    final_lines.extend(analysis_commands)
                    final_lines.append(line)
                    control_inserted = True
                elif line.lower().strip() == '.end' and not control_inserted:
                    # Si no hay .control, insertar antes de .end
                    final_lines.extend(analysis_commands)
                    final_lines.append('.control')
                    final_lines.append('run')
                    final_lines.append(f'write {raw}')
                    final_lines.append('.endc')
                    final_lines.append(line)
                    control_inserted = True
                else:
                    final_lines.append(line)
            
            modified_lines = final_lines
        
        # Si no hay bloque .control, agregarlo
        if not any('.control' in line.lower() for line in lines):
            for i, line in enumerate(modified_lines):
                if line.lower().strip() == '.end':
                    control_block = ['.control', 'run', f'write {raw}', '.endc']
                    modified_lines = modified_lines[:i] + control_block + modified_lines[i:]
                    break
        
        modified_net = '\n'.join(modified_lines)
        
        with open(sp, "w") as f: 
            f.write(modified_net)
        
        # Ejecutar ngspice
        res = subprocess.run(["ngspice", "-b", "-o", log, sp], capture_output=True, text=True)
        ok = (res.returncode == 0)
        logs = open(log).read() if os.path.exists(log) else (res.stderr or res.stdout)

        # Leer datos del archivo rawfile
        xvals, yvals = [], []
        plot_title = "Simulation Results"
        x_label = "Frequency (Hz)"
        y_label = "Magnitude"
        
        if os.path.exists(raw):
            try:
                # Primero, verificar si el archivo es binario o ASCII
                with open(raw, 'rb') as f:
                    first_bytes = f.read(1000)  # Leer más bytes para el header
                    is_binary = b'Binary:' in first_bytes
                
                if is_binary:
                    # Manejar archivo rawfile binario
                    import struct
                    
                    with open(raw, 'rb') as f:
                        # Leer header ASCII
                        header_lines = []
                        current_line = b''
                        
                        while True:
                            byte = f.read(1)
                            if not byte:
                                break
                            if byte == b'\n':
                                line = current_line.decode('ascii', errors='ignore').strip()
                                header_lines.append(line)
                                current_line = b''
                                
                                # Buscar el final del header
                                if line.startswith('Binary:') or line.startswith('Values:'):
                                    break
                            else:
                                current_line += byte
                        
                        # Procesar header
                        num_variables = 0
                        num_points = 0
                        variables = []
                        
                        for line in header_lines:
                            if line.startswith('Title:'):
                                plot_title = line.split(':', 1)[1].strip()
                            elif line.startswith('No. Variables:'):
                                num_variables = int(line.split(':')[1].strip())
                            elif line.startswith('No. Points:'):
                                num_points = int(line.split(':')[1].strip())
                            elif line.startswith('Variables:'):
                                continue
                            elif '\t' in line and len(line.split('\t')) >= 3:
                                parts = line.split('\t')
                                if len(parts) >= 3 and parts[0].isdigit():
                                    variables.append({
                                        'index': int(parts[0]),
                                        'name': parts[1],
                                        'type': parts[2]
                                    })
                        
                        # Leer datos binarios
                        if num_variables >= 2 and num_points > 0:
                            # Buscar donde empiezan los datos binarios
                            binary_start = f.tell()
                            
                            # Verificar si los datos son complejos
                            is_complex = any('complex' in line.lower() for line in header_lines)
                            
                            if is_complex:
                                # Datos complejos: cada valor son 16 bytes (real + imaginaria)
                                bytes_per_value = 16
                            else:
                                # Datos reales: cada valor son 8 bytes
                                bytes_per_value = 8
                            
                            bytes_per_point = num_variables * bytes_per_value
                            
                            for point in range(num_points):
                                try:
                                    # Leer datos para este punto
                                    point_data = f.read(bytes_per_point)
                                    if len(point_data) < bytes_per_point:
                                        break
                                    
                                    if is_complex:
                                        # Desempaquetar como complex doubles
                                        # Cada valor complejo son 2 doubles: real + imaginaria
                                        raw_values = struct.unpack(f'{num_variables * 2}d', point_data)
                                        
                                        # Convertir a valores complejos y tomar magnitud
                                        values = []
                                        for i in range(0, len(raw_values), 2):
                                            real = raw_values[i]
                                            imag = raw_values[i + 1]
                                            magnitude = math.sqrt(real * real + imag * imag)
                                            values.append(magnitude)
                                    else:
                                        # Desempaquetar como doubles reales
                                        values = struct.unpack(f'{num_variables}d', point_data)
                                    
                                    if len(values) >= 3:
                                        x_val = values[0]  # Frecuencia (primera variable)
                                        y_val = values[2]  # v(out) - tercera variable (índice 2)
                                        
                                        # Para análisis AC, convertir magnitud a dB
                                        if 'ac' in plot_title.lower() and y_val > 0:
                                            y_val = 20 * math.log10(y_val)
                                        
                                        xvals.append(x_val)
                                        yvals.append(y_val)
                                        
                                except struct.error as e:
                                    print(f"Struct error at point {point}: {e}")
                                    break
                
                else:
                    # Manejar archivo rawfile ASCII (código anterior)
                    with open(raw, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                        
                    lines = content.split('\n')
                    variables = []
                    num_variables = 0
                    
                    for i, line in enumerate(lines):
                        line = line.strip()
                        
                        if line.startswith('Title:'):
                            plot_title = line.split(':', 1)[1].strip()
                        elif line.startswith('No. Variables:'):
                            num_variables = int(line.split(':')[1].strip())
                        elif line.startswith('Variables:'):
                            # Leer variables
                            var_idx = i + 1
                            variables = []
                            while var_idx < len(lines) and var_idx < i + 1 + num_variables:
                                var_line = lines[var_idx].strip()
                                if var_line and not var_line.startswith('Values:'):
                                    parts = var_line.split('\t')
                                    if len(parts) >= 3:
                                        variables.append({
                                            'index': int(parts[0]),
                                            'name': parts[1],
                                            'type': parts[2]
                                        })
                                var_idx += 1
                            break
                    
                    # Buscar datos
                    for i, line in enumerate(lines):
                        if line.strip().startswith('Values:'):
                            data_idx = i + 1
                            current_point = {}
                            
                            while data_idx < len(lines):
                                data_line = lines[data_idx].strip()
                                if not data_line:
                                    data_idx += 1
                                    continue
                                    
                                try:
                                    parts = data_line.replace('\t', ' ').split()
                                    if len(parts) >= 2:
                                        var_idx = int(parts[0])
                                        value = float(parts[1])
                                        current_point[var_idx] = value
                                        
                                        if len(current_point) == num_variables:
                                            if 0 in current_point and 1 in current_point:
                                                x_val = current_point[0]
                                                y_val = current_point[1]
                                                
                                                if 'ac' in plot_title.lower() and y_val > 0:
                                                    y_val = 20 * math.log10(abs(y_val))
                                                
                                                xvals.append(x_val)
                                                yvals.append(y_val)
                                            
                                            current_point = {}
                                            
                                except (ValueError, IndexError):
                                    pass
                                    
                                data_idx += 1
                            break
                
                # Configurar etiquetas basadas en las variables
                if len(variables) >= 2:
                    x_var = variables[0]['name'].lower()
                    y_var = variables[1]['name'].lower()
                    
                    if 'frequency' in x_var:
                        x_label = "Frequency (Hz)"
                        if 'ac' in plot_title.lower():
                            y_label = "Magnitude (dB)"
                        else:
                            y_label = "Magnitude (V)"
                    elif 'time' in x_var:
                        x_label = "Time (s)"
                        y_label = "Voltage (V)"
                    
                    # Usar nombre real de la variable si es descriptivo
                    if len(variables[1]['name']) > 4:  # Evitar nombres como v(1)
                        y_label = variables[1]['name']
                    
            except Exception as e:
                print(f"Error reading rawfile: {e}")
                # Fallback: usar datos vacíos
                pass

        return {
            "ok": ok, 
            "logs": logs, 
            "x": xvals, 
            "y": yvals,
            "plot_title": plot_title,
            "x_label": x_label,
            "y_label": y_label
        }


@app.get("/files")
def list_files():
    """Lista los archivos .cir en el directorio circuits_generated"""
    try:
        files = []
        if os.path.exists(CIRCUITS_DIR):
            for filename in os.listdir(CIRCUITS_DIR):
                if filename.endswith('.cir'):
                    filepath = os.path.join(CIRCUITS_DIR, filename)
                    files.append({
                        "name": filename,
                        "path": filepath,
                        "modified": os.path.getmtime(filepath)
                    })
        # Ordenar por fecha de modificación (más reciente primero)
        files.sort(key=lambda x: x["modified"], reverse=True)
        return {"files": files}
    except Exception as e:
        return {"files": [], "error": str(e)}


@app.get("/files/{filename}")
def get_file_content(filename: str):
    """Obtiene el contenido de un archivo específico"""
    try:
        filepath = os.path.join(CIRCUITS_DIR, filename)
        if not os.path.exists(filepath) or not filename.endswith('.cir'):
            return {"error": "File not found"}
        
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        return {"content": content, "filename": filename}
    except Exception as e:
        return {"error": str(e)}


@app.post("/files/{filename}")
def save_file_content(filename: str, body: dict = Body(...)):
    """Guarda el contenido de un archivo"""
    try:
        if not filename.endswith('.cir'):
            return {"error": "Only .cir files are allowed"}
        
        filepath = os.path.join(CIRCUITS_DIR, filename)
        content = body.get("content", "")
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        
        return {"success": True, "filename": filename}
    except Exception as e:
        return {"error": str(e)}

# Ejecuta: uvicorn backend.app:app --reload --port 8000
