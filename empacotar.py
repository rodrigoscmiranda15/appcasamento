#!/usr/bin/env python3
"""
empacotar.py — gera a versão standalone a partir do app-v3.html.

    python3 empacotar.py                      # usa /api/extrair (proxy)
    python3 empacotar.py --sem-extracao       # esconde o upload

Saída em ./dist: index.html, manifest.json, icon-180.png, icon-512.png
Fonte única: você continua editando app-v3.html e roda isto de novo.
"""
import re, sys, json, base64, pathlib, struct, zlib

ORIGEM = pathlib.Path("app-v3.html")
DIST = pathlib.Path("docs"); DIST.mkdir(exist_ok=True)
SEM_EXTRACAO = "--sem-extracao" in sys.argv
PROXY = "/api/extrair"

APP_NOME = "Orçamento do casamento"
COR_TEMA = "#faf9f7"      # igual ao --bg: a barra de status encosta sem emenda
COR_ACENTO = "#1c5d4a"

# ---------------------------------------------------------------
# 1. Shim de armazenamento. A API do artefato é assíncrona e lança
#    erro quando a chave não existe — localStorage precisa imitar
#    isso, senão o app entende "sem dados" como "dados vazios".
# ---------------------------------------------------------------
SHIM = """
<script>
window.storage = window.storage || {
  async get(k){
    const v = localStorage.getItem(k);
    if (v === null) throw new Error("chave inexistente: " + k);
    return { key:k, value:v, shared:false };
  },
  async set(k,v){ localStorage.setItem(k,v); return { key:k, value:v, shared:false }; },
  async delete(k){ localStorage.removeItem(k); return { key:k, deleted:true }; },
  async list(prefix=""){
    return { keys:Object.keys(localStorage).filter(k=>k.startsWith(prefix)), prefix };
  }
};
</script>
"""

# ---------------------------------------------------------------
# 2. Ajustes de tela cheia e de iOS.
#    - 100dvh, não 100vh: o vh do Safari inclui a barra que some ao rolar
#    - input com 16px: abaixo disso o iOS dá zoom ao focar e não volta
#    - safe-area: recorte do notch e barra inferior
# ---------------------------------------------------------------
CSS_MOBILE = """
<style>
html,body{margin:0;padding:0;background:%(bg)s;
  -webkit-text-size-adjust:100%%;overscroll-behavior-y:none}
body{min-height:100dvh}
@media (max-width:680px){
  #app{padding:0}
  #app .stage{max-width:none;width:100%%;height:100dvh;border:0;border-radius:0;box-shadow:none}
  #app .screen{padding-top:max(var(--s6),calc(env(safe-area-inset-top) + var(--s4)))}
  #app .fab{bottom:calc(84px + env(safe-area-inset-bottom))}
  #app .sheet{padding-bottom:calc(var(--s6) + env(safe-area-inset-bottom))}
  #app input,#app select,#app textarea{font-size:16px}
  #app .parc-row input,#app .gen input{font-size:16px}
}
</style>
"""

def png(size, bg, fg):
    """PNG mínimo: quadrado com a cor de fundo e um bloco central. Sem dependências."""
    def rgb(h): h=h.lstrip("#"); return tuple(int(h[i:i+2],16) for i in (0,2,4))
    b, f = rgb(bg), rgb(fg)
    m, e = size//4, size//8
    linhas = b""
    for y in range(size):
        linha = b"\x00"
        for x in range(size):
            dentro = m <= x < size-m and m <= y < size-m
            buraco = m+e <= x < size-m-e and m+e <= y < size-m-e and y > size//2
            linha += bytes(f if (dentro and not buraco) else b)
        linhas += linha
    def bloco(tipo, dados):
        return (struct.pack(">I", len(dados)) + tipo + dados +
                struct.pack(">I", zlib.crc32(tipo+dados) & 0xffffffff))
    return (b"\x89PNG\r\n\x1a\n"
            + bloco(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + bloco(b"IDAT", zlib.compress(linhas, 9))
            + bloco(b"IEND", b""))

def main():
    if not ORIGEM.exists():
        sys.exit(f"não encontrei {ORIGEM}")
    corpo = ORIGEM.read_text(encoding="utf-8")

    # 3. Troca a chamada do artefato pelo proxy do servidor
    if SEM_EXTRACAO:
        corpo = corpo.replace('<div class="field">\n      <span class="label">Importar do arquivo</span>',
                              '<div class="field" hidden>\n      <span class="label">Importar do arquivo</span>')
    else:
        antigo = re.search(
            r'const r=await fetch\("https://api\.anthropic\.com/v1/messages".*?\}\)\}\);',
            corpo, re.S)
        if not antigo:
            print("  ! não achei a chamada de extração; conferir manualmente")
        else:
            novo = ('const r=await fetch("%s",{method:"POST",'
                    'headers:{"Content-Type":"application/json"},'
                    'body:JSON.stringify({mime:file.type,data:b64,'
                    'prompt:PROMPT(S.plano.map(c=>c.id).join(", "),S.evento.convidados)})});' % PROXY)
            corpo = corpo.replace(antigo.group(0), novo)
            # o proxy já devolve JSON limpo: some o recorte do primeiro { ao último }
            corpo = corpo.replace(
                'const data=await r.json();\n    if(data.error)throw new Error(data.error.message||"erro na leitura");\n'
                '    const raw=(data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");\n'
                '    const a=raw.indexOf("{"),z=raw.lastIndexOf("}");\n'
                '    if(a<0||z<0)throw new Error("não veio um resultado legível");\n'
                '    const d=JSON.parse(raw.slice(a,z+1));',
                'const d=await r.json();\n    if(d.error)throw new Error(d.error);')

    html = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{APP_NOME}</title>
<meta name="theme-color" content="{COR_TEMA}">
<meta name="color-scheme" content="light">
<meta name="description" content="Controle de orçamento e parcelas do casamento.">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Orçamento">
{CSS_MOBILE % {"bg": COR_TEMA}}
{SHIM}
</head>
<body>
{corpo}
</body>
</html>
"""
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / "manifest.json").write_text(json.dumps({
        "name": APP_NOME, "short_name": "Orçamento",
        "start_url": ".", "scope": ".", "display": "standalone",
        "orientation": "portrait",
        "background_color": COR_TEMA, "theme_color": COR_TEMA,
        "icons": [
            {"src": "icon-180.png", "sizes": "180x180", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}
        ]
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    for s in (180, 512):
        (DIST / f"icon-{s}.png").write_bytes(png(s, COR_ACENTO, COR_TEMA))

    kb = len(html.encode()) / 1024
    print(f"docs/index.html  {kb:.0f} KB"
          f"{'  (sem extração)' if SEM_EXTRACAO else f'  extração via {PROXY}'}")
    print("dist/manifest.json, dist/icon-180.png, dist/icon-512.png")

if __name__ == "__main__":
    main()
