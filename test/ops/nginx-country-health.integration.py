#!/usr/bin/env python3
"""Opt-in real GeoIP2/health-cache check; isolated nginx, no production requests."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--templates', type=Path, default=root / 'scripts/hardening')
    parser.add_argument('--db', type=Path, default=root / 'geoip/GeoLite2-Country.mmdb')
    parser.add_argument('--nginx', default='/usr/sbin/nginx')
    parser.add_argument('--module', default='/usr/lib/nginx/modules/ngx_http_geoip2_module.so')
    args = parser.parse_args()
    state = {'calls': 0, 'error': False}

    class Backend(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.headers.get('Upgrade') == 'websocket':
                self.send_response(101); self.send_header('Upgrade', 'websocket')
                self.send_header('Connection', 'Upgrade'); self.end_headers(); return
            if self.path.startswith('/healthz'):
                state['calls'] += 1
                if state['error']:
                    self.send_response(503); self.end_headers(); return
                # A slow fill makes concurrent cache-lock behavior observable.
                time.sleep(0.05)
                body = {'build': 'fixture'} if self.path == '/healthz?build=1' else {'build': 'fixture', 'calls': state['calls']}
                if 'traffic=1' in self.path:
                    body.update(memory='private', traffic='private')
            else:
                body = {'ok': True}
            encoded = json.dumps(body).encode()
            self.send_response(200); self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(encoded)))
            self.end_headers(); self.wfile.write(encoded)

    backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    reserve = socket.socket(); reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]; reserve.close()
    child = None
    try:
        with tempfile.TemporaryDirectory(prefix='sp-geoip-nginx-') as temporary:
            folder = Path(temporary)
            geo = (args.templates / 'sp-geoip-country.conf.example').read_text().replace('/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb', str(args.db.resolve()))
            maps = (args.templates / 'sp-public-api-map.conf').read_text() + (args.templates / 'sp-health-cache-map.conf').read_text()
            example = (args.templates / 'nginx.conf.example').read_text() if (args.templates / 'nginx.conf.example').exists() else (root / 'scripts/nginx.conf.example').read_text()
            health = re.search(r'        location = /healthz \{.*?\n        \}', example, re.S)[0]
            health = health.replace('127.0.0.1:3000', '127.0.0.1:' + str(backend.server_port))
            config = f'''load_module {args.module};
pid {folder}/nginx.pid;
error_log {folder}/error.log;
events {{ worker_connections 256; }}
http {{
proxy_cache_path {folder}/cache levels=1:2 keys_zone=sp_assets:1m;
log_format check '$remote_addr "$request" $status req=$limit_req_status conn=$limit_conn_status';
access_log {folder}/access.log check;
map $http_upgrade $connection_upgrade {{ default upgrade; '' close; }}
{geo}
{maps}
server {{
listen 127.0.0.1:{port};
set_real_ip_from 127.0.0.1;
real_ip_header X-SP-Test-IP;
if ($sp_geoip_denied) {{ return 444; }}
if ($sp_close_public_api) {{ return 444; }}
limit_req_status 444;
limit_conn_status 444;
limit_req zone=sp_health_global burst=40 nodelay;
{health}
location / {{ proxy_pass http://127.0.0.1:{backend.server_port}; proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; }}
}}
}}
'''
            conf = folder / 'nginx.conf'; conf.write_text(config)
            def check(file):
                return subprocess.run([args.nginx, '-p', str(folder) + '/', '-c', str(file), '-t'], capture_output=True, text=True)
            checked = check(conf); assert checked.returncode == 0, checked.stderr
            child = subprocess.Popen([args.nginx, '-p', str(folder) + '/', '-c', str(conf), '-g', 'daemon off; master_process off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def request(path='/', ip='114.114.114.114', method='GET', extra=''):
                data = b''
                with socket.create_connection(('127.0.0.1', port), timeout=4) as conn:
                    conn.sendall((f'{method} {path} HTTP/1.1\r\nHost: fixture\r\nX-SP-Test-IP: {ip}\r\nCF-Connecting-IP: 114.114.114.114\r\nX-Forwarded-For: 114.114.114.114\r\nConnection: close\r\n{extra}\r\n').encode())
                    try:
                        while True:
                            part = conn.recv(65536)
                            if not part: break
                            data += part
                            if b' 101 ' in data.split(b'\r\n')[0]: break
                    except ConnectionResetError:
                        pass
                if not data: return 0, {}, b''
                head, body = data.split(b'\r\n\r\n', 1)
                headers = {k.lower(): v.strip() for k, v in (line.decode().split(':', 1) for line in head.split(b'\r\n')[1:])}
                return int(head.split()[1]), headers, body

            for _ in range(60):
                try:
                    if request()[0] == 200: break
                except ConnectionRefusedError:
                    pass
                time.sleep(0.05)
            else:
                raise AssertionError('Fixture nginx failed to start')
            for ip in ['114.114.114.114', '223.5.5.5', '240e::1', '127.0.0.1']:
                assert request(ip=ip)[0] == 200, ip
            for ip in ['8.8.8.8', '60.249.21.30', '1.36.0.1', '203.0.113.9', '2001:db8::1', '2001:4860:4860::8888', '172.16.0.42']:
                for path in ['/', '/healthz', '/ws', '/assets/file.js', '/api/nickname/validate']:
                    assert request(path, ip)[0] == 0, (ip, path)
            assert request('/ws', extra='Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')[0] == 101
            assert request('/metrics')[0] == 0

            with ThreadPoolExecutor(max_workers=16) as pool:
                filled = list(pool.map(lambda _i: request('/healthz'), range(16)))
            assert all(status == 200 for status, _, _ in filled)
            assert state['calls'] == 1, state
            assert sum(headers.get('x-health-cache') == 'MISS' for _, headers, _ in filled) == 1
            expected = filled[0][2]
            for path, extra in [('/healthz?traffic=1&nonce=2', ''), ('/%68ealthz?random=3', 'Cache-Control: no-cache\r\nRange: bytes=0-1,3-4\r\nHost: attacker\r\n')]:
                status, headers, body = request(path, extra=extra.replace('Host: attacker\r\n', ''))
                assert status == 200 and headers.get('x-health-cache') == 'HIT' and body == expected
                assert b'private' not in body
            assert request('/healthz', extra='Authorization: Bearer bypass\r\n')[0] == 0
            assert request('/healthz', method='POST')[0] == 0
            for _ in range(2):
                status, headers, body = request('/healthz?traffic=1', '127.0.0.1')
                assert status == 200 and headers.get('x-health-cache') == 'BYPASS' and b'private' in body
            state['error'] = True
            assert request('/healthz?build=1')[0] == 503
            state['error'] = False
            status, headers, body = request('/healthz?build=1')
            assert status == 200 and headers.get('x-health-cache') == 'MISS' and json.loads(body) == {'build': 'fixture'}
            time.sleep(6.1)
            status, headers, _body = request('/healthz')
            assert status == 200 and headers.get('x-health-cache') == 'EXPIRED'
            with ThreadPoolExecutor(max_workers=16) as pool:
                flood = list(pool.map(lambda i: request('/healthz?nonce=' + str(i), '114.114.114.' + str(i + 1))[0], range(100)))
            assert 0 in flood and 200 in flood, 'Distributed health limit did not reject excess requests'
            assert 'req=REJECTED' in (folder / 'access.log').read_text()
            for value in ['missing.mmdb', 'corrupt.mmdb']:
                invalid = folder / value
                if value.startswith('corrupt'): invalid.write_bytes(b'invalid database')
                bad = folder / 'bad.conf'; bad.write_text(config.replace(str(args.db.resolve()), str(invalid)))
                assert check(bad).returncode != 0, value
            print('PASS: CN IPv4/IPv6; foreign/unknown 444; forged headers ignored; WS; cache lock; 5s expiry; canonical query keys; private bypass; error not cached; distributed global limit; missing/corrupt DB fails validation')
    finally:
        if child:
            child.terminate()
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        backend.shutdown(); backend.server_close()


if __name__ == '__main__':
    main()
