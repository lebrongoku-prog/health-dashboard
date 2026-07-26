"""Lokaler Test-Server für das Health Command Center.

Wie `python3 -m http.server`, schickt aber `Cache-Control: no-store` mit — sonst liefert der
Browser beim Prüfen einer Änderung weiter die alte app.js aus. Nur zum Entwickeln gedacht;
für das Deployment auf GitHub Pages ist er nicht beteiligt.

Port 8124 (FitTrack belegt 8123, beide können damit parallel laufen).

Hinweis: Google-OAuth funktioniert lokal NICHT — REDIRECT_URI in app.js zeigt fest auf die
GitHub-Pages-URL. Der Login-Screen erscheint, echte Daten werden nicht geladen. Für den
Zweck hier reicht das: Syntax- und Ladefehler stehen sofort in der Konsole, noch bevor
Auth überhaupt eine Rolle spielt.
"""
import http.server
import socketserver

PORT = 8124


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
        print(f"Health Command Center dev server on http://localhost:{PORT}")
        httpd.serve_forever()
