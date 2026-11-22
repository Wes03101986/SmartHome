"""Kleine Brücke: liest den E3DC per RSCP (Bibliothek pye3dc) und stellt die Werte lokal als JSON bereit.
Wird vom Dashboard-Server automatisch gestartet. Voraussetzung: pip install pye3dc"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
try:
    from e3dc import E3DC
except ImportError:
    sys.exit('Solar: Python-Paket fehlt. Bitte im Terminal ausführen:  pip install pye3dc')

cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json'), encoding='utf-8')).get('solar', {})
lock, conn = threading.Lock(), {'obj': None}

def read():
    for k in ('username', 'password', 'key'):
        if not cfg.get(k):
            return {'error': f'In config.json fehlt solar.{k} (Portal-Benutzer, Portal-Passwort, RSCP-Passwort).'}
    try:
        if conn['obj'] is None:
            conn['obj'] = E3DC(E3DC.CONNECT_LOCAL, username=cfg['username'], password=cfg['password'],
                               ipAddress=cfg.get('ip', '192.168.0.61'), key=cfg['key'], configuration={})
        p = conn['obj'].poll(keepAlive=True)
        prod, cons = p.get('production', {}), p.get('consumption', {})
        return {'pv': prod.get('solar', 0), 'batt': cons.get('battery', 0), 'house': cons.get('house', 0),
                'grid': prod.get('grid', 0), 'add': prod.get('add', 0), 'wallbox': cons.get('wallbox', 0),
                'soc': p.get('stateOfCharge', 0), 'autarky': p.get('autarky', 0), 'selfUse': p.get('selfConsumption', 0)}
    except Exception as e:
        conn['obj'] = None
        return {'error': f'{type(e).__name__}: {e}'}

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        with lock:
            body = json.dumps(read()).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

HTTPServer(('127.0.0.1', int(cfg.get('bridgePort', 5051))), H).serve_forever()
