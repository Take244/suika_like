#!/usr/bin/env python3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from functools import partial
import os, sys

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Disable caching to reflect live edits
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

def run(port: int, host: str, directory: str):
    handler = partial(NoCacheHandler, directory=directory)
    httpd = HTTPServer((host, port), handler)
    print(f"Serving '{directory}' at http://{host}:{port}/ (Ctrl+C to stop)")
    print("Open index.html: http://{host}:{port}/index.html")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port '{sys.argv[1]}', falling back to {port}")
    directory = os.path.dirname(os.path.abspath(__file__))
    run(port, host, directory)

