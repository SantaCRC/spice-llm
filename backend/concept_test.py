import requests
import json

question = "Generates a ngspice netlist for a simple RC low-pass filter."

url = "https://openrouter.ai/api/v1/chat/completions"
headers = {
  "Authorization": f"Bearer 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",
  "HTTP-referer": "https://ditsolabs.github.io/",
  "X-Title": "NGSpice Netlist Generation",
  "Content-Type": "application/json"
}

payload = {
  "model": "deepseek/deepseek-chat-v3.1:free",
  "messages": [{"role": "user", "content": question}],
  "stream": True
}

buffer = ""
full_response = ""
with requests.post(url, headers=headers, json=payload, stream=True) as r:
  for chunk in r.iter_content(chunk_size=1024, decode_unicode=True):
    buffer += chunk
    while True:
      try:
        line_end = buffer.find('\n')
        if line_end == -1:
          break

        line = buffer[:line_end].strip()
        buffer = buffer[line_end + 1:]

        if line.startswith('data: '):
          data = line[6:]
          if data == '[DONE]':
            break

          try:
            data_obj = json.loads(data)
            content = data_obj["choices"][0]["delta"].get("content")
            if content:
              print(content, end="", flush=True)  # Imprime toda la respuesta
              full_response += content
          except json.JSONDecodeError:
            pass
      except Exception:
        break

# Procesar la respuesta completa para extraer bloques SPICE
spice_blocks = []
content = full_response
while True:
  start = content.find('```spice')
  if start == -1:
    break
  
  # Encontrar el final del bloque
  start_content = start + len('```spice')
  end = content.find('```', start_content)
  if end == -1:
    break
  
  # Extraer el bloque SPICE
  spice_code = content[start_content:end].strip()
  spice_blocks.append(spice_code)
  
  # Continuar buscando después de este bloque
  content = content[end + 3:]

# Guardar cada bloque spice en un archivo .cir
for i, block in enumerate(spice_blocks, 1):
  filename = f"circuits_generated/spice_block_{i}.cir"
  with open(filename, "w") as f:
    f.write(block)
  print(f"\nArchivo guardado: {filename}")
