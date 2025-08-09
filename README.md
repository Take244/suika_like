Fruity Merge (Suika-like) — Local Run

Quick start
- Python: `cd suika-like && python3 serve.py 8000` then open `http://127.0.0.1:8000/index.html`.
- Host for phone: `HOST=0.0.0.0 python3 serve.py 8000` and open `http://<YOUR-LAN-IP>:8000/index.html` on the phone (same Wi‑Fi).

Controls
- Drag on the canvas to move the spawn position, release/tap to drop the fruit.

Tuning
- Edit constants in `main.js`:
  - `LEVELS`: radii, color, score per level.
  - `GRAVITY`, `RESTITUTION`, `DAMPING` for feel.
  - `TOP_LINE_Y`, `MERGE_COOLDOWN`, `MERGE_OVERLAP_FACTOR` for difficulty.

Notes
- Best score is saved in `localStorage` under the key `fruity.best`.
- Caching is disabled by the server so changes reflect on refresh.

# suika_like
