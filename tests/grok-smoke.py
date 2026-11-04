#!/usr/bin/env python3
"""Exercise native Grok activation with a loopback provider, without API credentials."""
import http.server, json, os, pathlib, subprocess, sys, tempfile, threading
root = pathlib.Path(tempfile.mkdtemp(prefix="pstack-grok-smoke-"))
home = root / "home"
grok = home / ".grok"
evidence = root / "evidence"
for directory in (grok, evidence, root / "work", root / "config", root / "data", root / "cache", root / "state"):
    directory.mkdir(parents=True, exist_ok=True)
requests = []
plugin = pathlib.Path(__file__).resolve().parents[1] / "plugins/pstack"
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        data=json.dumps({'object':'list','data':[{'id':'probe','object':'model','created':0,'owned_by':'synthetic'}]}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        try: value=json.loads(body)
        except Exception: value={'raw':body.decode(errors='replace')}
        requests.append({'path':self.path,'body':value})
        (evidence/'requests.json').write_text(json.dumps(requests,indent=2))
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        chunks=[{'id':'probe-1','object':'chat.completion.chunk','created':1,'model':'probe','choices':[{'index':0,'delta':{'role':'assistant','content':'OK'},'finish_reason':None}]}, {'id':'probe-1','object':'chat.completion.chunk','created':1,'model':'probe','choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}]
        try:
            for chunk in chunks: self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
        except BrokenPipeError: pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
port=server.server_address[1]
(grok/'config.toml').write_text('[models]\ndefault = "probe"\n[model.probe]\nmodel = "probe"\nbase_url = "http://127.0.0.1:%d/v1"\napi_key = "synthetic"\napi_backend = "chat_completions"\ncontext_window = 100000\n'%port)
env={'HOME':str(home),'GROK_HOME':str(grok),'XDG_CONFIG_HOME':str(root/'config'),'XDG_DATA_HOME':str(root/'data'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_STATE_HOME':str(root/'state'),'PATH':'/opt/homebrew/bin:/usr/bin:/bin','GROK_MODELS_BASE_URL':'http://127.0.0.1:%d/v1'%port,'XAI_API_KEY':'synthetic','GROK_TELEMETRY_DISABLED':'1','NO_COLOR':'1','TERM':'dumb'}
def run(label,args,timeout=25):
    try:
        p=subprocess.run([os.environ.get('GROK', 'grok'),*args],cwd=root/'work',env=env,capture_output=True,text=True,timeout=timeout)
        (evidence/(label+'.stdout')).write_text(p.stdout);(evidence/(label+'.stderr')).write_text(p.stderr)
        print(label,'exit',p.returncode,flush=True);return p.returncode
    except subprocess.TimeoutExpired:
        print(label,'TIMEOUT',flush=True);return 124

assert run('install', ['plugin', 'install', str(plugin), '--trust']) == 0
assert run('enable', ['plugin', 'enable', 'pstack']) == 0
assert run('enabled', ['-p', '/poteto-mode', '-m', 'probe', '--output-format', 'json']) == 0
first = json.dumps(requests)
assert 'On every task, read pstack' in first
assert 'references/grok-tools.md' in first
requests.clear()
assert run('disable', ['plugin', 'disable', 'pstack']) == 0
assert run('disabled', ['-p', '/poteto-mode', '-m', 'probe', '--output-format', 'json']) == 0
second = json.dumps(requests)
assert 'On every task, read pstack' not in second
assert 'references/grok-tools.md' not in second
assert run('uninstall', ['plugin', 'uninstall', 'pstack', '--confirm']) == 0
server.shutdown()
print('PASS: native skill routing description and explicit skill expansion disappear when disabled')
print('Evidence:', evidence)
