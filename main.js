(() => {
  'use strict';

  // World and rendering setup
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const overlay = document.getElementById('overlay');
  const finalScoreEl = document.getElementById('final-score');
  const restartBtn = document.getElementById('restart');

  // Logical world size in pixels (scaled to canvas size by CSS)
  const W = 360; // width
  const H = 560; // height (短く調整)
  canvas.width = W; canvas.height = H;

  // Visual theme: 'fruit' or 'bear' (bearは画像優先・なければ描画)
  const THEME = 'bear';
  const ASSET_PATH = 'assets';
  const TRIM_ALPHA_THRESHOLD = 10; // 0-255: 透過を無視するしきい値
  const SPRITE_FIT_SCALE = 1.3;   // わずかに大きく描いて隙間を解消
  const DRAW_SPRITE_SHADOW = false; // 画像スプライトには影を付けない
  const COLLIDER_INFLATE = 1.06;    // 物理半径を見た目より少し大きくして継ぎ目を消す
  const bearSprites = new Array(10).fill(null); // レベルごとのトリム済みスプライト情報

  // Safe area for spawning and top line
  const TOP_LINE_Y = 78; // where the red line is drawn (Hに合わせて調整)
  const SPAWN_Y = 35;    // y position to preview/spawn above line

  // Physics params
  let GRAVITY = 2000;        // px/s^2
  let DAMPING = 0.996;       // velocity damping each step
  let RESTITUTION = 0.18;    // bounciness（低めで跳ねを抑える）
  let WALL_RESTITUTION = 0.15;
  const SOLVER_PASSES = 6;   // 衝突解決の反復回数（重なり低減）
  const CORR_PERCENT = 0.9;  // 重なり補正の割合（Baumgarte）
  const CORR_SLOP = 0.5;     // 小さなめり込みの許容（px）
  const MU_SLIDE = 0.5;      // 接触時のクーロン摩擦係数（接線摩擦）
  const FLOOR_FRICTION = 0.96; // 床接触中の横速度減衰
  const WALL_SLIDE_FRICTION = 0.98; // 壁接触時の縦速度減衰
  // 合体判定は「接触したら」に変更（衝突検出で記録）
  const MERGE_COOLDOWN = 0.25; // seconds after spawn/merge to avoid instant re-merge

  // Fruit levels (cute pastel colors). Radii in pixels.
  const LEVELS = [
    { name: 'Cherry',     radius: 20,  color: '#ff8aa8', score: 1 },
    { name: 'Strawberry', radius: 25,  color: '#ff6f91', score: 3 },
    { name: 'Grape',      radius: 30,  color: '#b085f5', score: 6 },
    { name: 'Orange',     radius: 35,  color: '#ffb75e', score: 10 },
    { name: 'Apple',      radius: 40,  color: '#ff8f6b', score: 15 },
    { name: 'Pear',       radius: 45,  color: '#9be15d', score: 22 },
    { name: 'Peach',      radius: 50,  color: '#ffcad4', score: 32 },
    { name: 'Pineapple',  radius: 60, color: '#ffe873', score: 46 },
    { name: 'Melon',      radius: 70, color: '#a0f0b7', score: 64 },
    { name: 'Watermelon', radius: 80, color: '#7bd389', score: 88 },
  ];

  let START_MAX_LEVEL = 4; // base spawn cap (may be further limited dynamically)
  let END_VIOLATION_MS = 1000; // time over line to trigger game over
  let SPAWN_MAX_DELTA_ABOVE_BOARD = 2; // dynamic cap: allowedMax <= highestOnBoard + delta
  let currentSpawnWeights = [0.25,0.22,0.20,0.18,0.15];

  // 盤面幅に収まる最大レベルを計算（壁厚12px×2を考慮）
  const MAX_RADIUS_INNER = (W - 24) / 2;
  const MAX_LEVEL_ALLOWED = (() => {
    let idx = 0;
    for (let i=0;i<LEVELS.length;i++){
      if (LEVELS[i].radius <= MAX_RADIUS_INNER) idx = i;
    }
    return idx;
  })();

  // State
  let fruits = []; // active fruit bodies
  let score = 0;
  let best = Number(localStorage.getItem('fruity.best') || '0') || 0;
  bestEl.textContent = String(best);
  let gameOver = false;
  let overTimer = 0; // ms maintaining over-line state
  let spawnX = W/2;
  let nextLevel = randNextLevel();

  // Timing
  let lastTime = performance.now();
  const FIXED_DT = 1/60; // s
  let accumulator = 0;

  // Input handling (touch and mouse)
  let pointerActive = false;

  // 単一設定（難易度UIなし）

  function randNextLevel(){
    // dynamic cap based on board state
    let highest = 0;
    for (const f of fruits) highest = Math.max(highest, f.level);
    const allowedMax = Math.min(START_MAX_LEVEL, Math.max(0, highest + SPAWN_MAX_DELTA_ABOVE_BOARD), MAX_LEVEL_ALLOWED);
    return pickLevelWeighted(allowedMax, currentSpawnWeights);
  }

  function pickLevelWeighted(maxLevel, weights){
    // use weights[0..] up to maxLevel; if not enough, repeat last weight
    const ww = [];
    for (let i=0;i<=maxLevel;i++) ww.push(weights[Math.min(i, weights.length-1)]);
    const sum = ww.reduce((a,b)=>a+b,0);
    let r = Math.random() * sum;
    for (let i=0;i<ww.length;i++){
      r -= ww[i]; if (r <= 0) return i;
    }
    return ww.length-1;
  }

  function addScore(v){
    score += v;
    scoreEl.textContent = String(score);
    if (score > best) { best = score; bestEl.textContent = String(best); }
  }

  function saveBest(){
    try { localStorage.setItem('fruity.best', String(best)); } catch {}
  }

  class Fruit {
    constructor(level, x, y){
      this.level = level;
      this.vr = LEVELS[level].radius;   // visual radius
      this.r  = this.vr * COLLIDER_INFLATE; // physics radius (slightly larger)
      this.x = x; this.y = y;
      this.vx = 0; this.vy = 0;
      this.ax = 0; this.ay = 0;
      this.static = false; // not used for preview; actual bodies are dynamic
      this.merging = false; // queued to merge this frame
      this.justBorn = 0;    // cooldown time left (s)
      this.id = Fruit._nextId++;
    }
  }
  Fruit._nextId = 1;

  function spawnFruit(level, x){
    // プレビュー位置と同じ安全な高さで生成
    const previewR = LEVELS[level].radius;
    const tempPhysicsR = previewR * COLLIDER_INFLATE;
    const f = new Fruit(level, clamp(x, 12 + tempPhysicsR, W - 12 - tempPhysicsR), SPAWN_Y);
    f.vx = 0; f.vy = 0;
    f.justBorn = MERGE_COOLDOWN;
    fruits.push(f);
  }

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  // Game loop
  function frame(ts){
    const dt = (ts - lastTime) / 1000;
    lastTime = ts;
    accumulator += dt;
    const maxFrame = 1/15; // avoid spiral of death
    if (accumulator > 0.5) accumulator = 0.5;

    while (accumulator >= FIXED_DT) {
      step(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    draw();
    requestAnimationFrame(frame);
  }

  function step(dt){
    if (gameOver) return;

    // Integrate
    for (const f of fruits){
      f.justBorn = Math.max(0, f.justBorn - dt);
      f.vy += GRAVITY * dt;
      f.vx += f.ax * dt; f.vy += f.ay * dt;
      f.x  += f.vx * dt; f.y  += f.vy * dt;
      f.vx *= DAMPING;   f.vy *= DAMPING;
    }

    // Collide with walls and floor
    const left = 12, right = W-12, bottom = H-8;
    for (const f of fruits){
      // left/right
      if (f.x - f.r < left) { f.x = left + f.r; f.vx = Math.abs(f.vx) * WALL_RESTITUTION; f.vy *= WALL_SLIDE_FRICTION; }
      if (f.x + f.r > right){ f.x = right - f.r; f.vx = -Math.abs(f.vx) * WALL_RESTITUTION; f.vy *= WALL_SLIDE_FRICTION; }
      // floor
      if (f.y + f.r > bottom){ f.y = bottom - f.r; f.vy = -Math.abs(f.vy) * WALL_RESTITUTION; f.vx *= FLOOR_FRICTION; }
    }

    // Pairwise circle collisions with iterative solver
    // 同レベルの接触ペアを記録して後段で合体
    const contactPairs = [];
    for (let pass=0; pass<SOLVER_PASSES; pass++){
      for (let i=0;i<fruits.length;i++){
        for (let j=i+1;j<fruits.length;j++){
          const a = fruits[i], b = fruits[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const r = a.r + b.r;
          const d2 = dx*dx + dy*dy;
          if (d2 <= 0) continue;
          if (d2 < r*r){
            const d = Math.sqrt(d2);
            const nx = dx / d, ny = dy / d;
            // 合体候補（接触）
            if (a.level === b.level && a.justBorn <= 0 && b.justBorn <= 0){
              contactPairs.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
            }
            // positional correction (split by mass ~ area ~ r^2)
            const overlap = r - d;
            const overlapEff = Math.max(0, overlap - CORR_SLOP) * CORR_PERCENT;
            const ma = a.r*a.r, mb = b.r*b.r; const msum = ma + mb;
            const corrA = overlapEff * (mb/msum);
            const corrB = overlapEff * (ma/msum);
            a.x -= nx * corrA; a.y -= ny * corrA;
            b.x += nx * corrB; b.y += ny * corrB;
            // impulse only on first pass to avoid jitter増幅
            if (pass === 0){
              const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
              const velAlongNormal = rvx*nx + rvy*ny;
              if (velAlongNormal < 0){
                const e = RESTITUTION;
                const jimp = -(1+e) * velAlongNormal / (1/ma + 1/mb);
                const impX = jimp * nx, impY = jimp * ny;
                a.vx -= impX / ma; a.vy -= impY / ma;
                b.vx += impX / mb; b.vy += impY / mb;

                // Tangential friction impulse（滑り低減）
                const tx = -ny, ty = nx;
                const vt = rvx*tx + rvy*ty;
                // 目標は接線相対速度を0に近づける（全吸収は避け、クーロン上限で制限）
                let jt = - vt / (1/ma + 1/mb);
                const jtMax = MU_SLIDE * Math.abs(jimp);
                if (jt > jtMax) jt = jtMax; else if (jt < -jtMax) jt = -jtMax;
                const itx = jt * tx, ity = jt * ty;
                a.vx -= itx / ma; a.vy -= ity / ma;
                b.vx += itx / mb; b.vy += ity / mb;
              }
            }
          }
        }
      }
    }

    // 合体キュー（このステップで接触したペア）
    const toMerge = contactPairs;
    // 重複除去：各フルーツは1回だけ合体
    toMerge.sort((p,q)=> p[0]-q[0] || p[1]-q[1]);
    const picked = new Set();
    const pairs = [];
    for (const [ida,idb] of toMerge){
      if (picked.has(ida) || picked.has(idb)) continue;
      picked.add(ida); picked.add(idb);
      pairs.push([ida,idb]);
    }
    if (pairs.length){
      // map ids
      const byId = new Map(fruits.map(f=>[f.id,f]));
      for (const [ida,idb] of pairs){
        const a = byId.get(ida), b = byId.get(idb);
        if (!a || !b) continue;
        const level = Math.min(a.level+1, MAX_LEVEL_ALLOWED);
        // new fruit at weighted average position
        const ma = a.r*a.r, mb = b.r*b.r; const msum = ma+mb;
        const nx = (a.x*ma + b.x*mb)/msum; const ny = (a.y*ma + b.y*mb)/msum;
        // remove a,b
        fruits = fruits.filter(f => f.id!==a.id && f.id!==b.id);
        const nf = new Fruit(level, nx, ny);
        // carry momentum
        nf.vx = (a.vx*ma + b.vx*mb)/msum;
        nf.vy = (a.vy*ma + b.vy*mb)/msum;
        nf.justBorn = MERGE_COOLDOWN;
        fruits.push(nf);
        addScore(LEVELS[level].score);
        // haptic
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
      }
      // 合体直後に軽い分離パスでめり込みを解消
      resolveOverlaps(3);
    }

    // Game over check: 上限ライン（キャンバス描画の線と同一）を安定して越えたら終了
    // justBorn中のフルーツは除外し、ヒステリシス（マージン）を入れる
    const OVERLINE_MARGIN = 3; // px
    let minTop = Infinity;
    for (const f of fruits){
      if (f.justBorn > 0) continue;
      const top = f.y - f.r;
      if (top < minTop) minTop = top;
    }
    const violating = Number.isFinite(minTop) && (minTop <= TOP_LINE_Y - OVERLINE_MARGIN);
    const ms = FIXED_DT*1000;
    if (violating) overTimer += ms; else overTimer = Math.max(0, overTimer - ms*2);
    if (overTimer >= END_VIOLATION_MS) { triggerGameOver(); }

    // 毎ステップ最後にも軽い分離を行い、残留めり込みを抑制
    resolveOverlaps(1);
  }

  function triggerGameOver(){
    if (gameOver) return;
    gameOver = true;
    finalScoreEl.textContent = String(score);
    overlay.hidden = false;
    saveBest();
  }

  function resolveOverlaps(iter=1){
    for (let k=0;k<iter;k++){
      for (let i=0;i<fruits.length;i++){
        for (let j=i+1;j<fruits.length;j++){
          const a = fruits[i], b = fruits[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const r = a.r + b.r;
          const d2 = dx*dx + dy*dy;
          if (d2 <= 0) continue;
          if (d2 < r*r){
            const d = Math.sqrt(d2);
            const nx = dx / d, ny = dy / d;
            const overlap = r - d;
            const overlapEff = Math.max(0, overlap - CORR_SLOP) * CORR_PERCENT;
            const ma = a.r*a.r, mb = b.r*b.r; const msum = ma + mb;
            const corrA = overlapEff * (mb/msum);
            const corrB = overlapEff * (ma/msum);
            a.x -= nx * corrA; a.y -= ny * corrA;
            b.x += nx * corrB; b.y += ny * corrB;
          }
        }
      }
    }
  }

  // Drawing
  function draw(){
    // clear
    ctx.clearRect(0,0,W,H);

    // playfield background
    drawContainer();

    // preview next entity
    drawPreview();

    // entities
    for (const f of fruits){
      drawEntity(f.x, f.y, f.vr, f.level, false);
    }

    // top line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, TOP_LINE_Y + .5);
    ctx.lineTo(W, TOP_LINE_Y + .5);
    ctx.strokeStyle = 'rgba(255,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8,6]);
    ctx.stroke();
    ctx.restore();
  }

  function drawContainer(){
    // side walls hint
    ctx.save();
    ctx.fillStyle = '#f7fbff';
    ctx.fillRect(0,0,W,H);
    // walls
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(0,0,12,H);
    ctx.fillRect(W-12,0,12,H);
    ctx.fillRect(0,H-8,W,8);
    ctx.restore();
  }

  function drawPreview(){
    // ghost fruit following spawnX
    const level = nextLevel;
    const r = LEVELS[level].radius;
    const pr = r * COLLIDER_INFLATE; // 物理上の当たりで壁に掛からないよう表示位置も制限
    const x = clamp(spawnX, 12+pr, W-12-pr);
    const y = SPAWN_Y;
    ctx.save();
    ctx.globalAlpha = 0.45;
    drawEntity(x,y,r,level,true);
    ctx.restore();
  }

  function drawEntity(x,y,r,level,isGhost){
    if (THEME === 'bear'){
      const spr = bearSprites[level];
      if (spr){
        if (DRAW_SPRITE_SHADOW) drawShadow(x,y,r);
        const { img, sx, sy, sw, sh } = spr;
        // 中身に合わせてスケール。円に対して少し大きめに描く
        const scale = Math.max((2*r)/sw, (2*r)/sh) * SPRITE_FIT_SCALE;
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = x - dw/2;
        const dy = y - dh/2;
        ctx.save();
        ctx.globalAlpha *= (isGhost? 0.9 : 1);
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.restore();
        return;
      }
      // フォールバック描画（内製ベアは影を付ける）
      drawShadow(x,y,r);
      return drawBear(x,y,r,isGhost);
    }
    return drawFruitLike(x,y,r,LEVELS[level].color,isGhost);
  }

  function drawShadow(x,y,r){
    ctx.save();
    ctx.beginPath();
    const sh = Math.max(2, r*0.2);
    ctx.ellipse(x, Math.min(H-6, y + r - 2), r*0.9, sh, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fill();
    ctx.restore();
  }

  function drawFruitLike(x,y,r,color,isGhost){
    // shadow（果物は内製で描くのでここで影も描く）
    drawShadow(x,y,r);

    // body
    ctx.save();
    const grad = ctx.createRadialGradient(x-r*0.4, y-r*0.6, r*0.3, x, y, r);
    grad.addColorStop(0, lighten(color, .18));
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fill();

    // face (cute)
    const eyeOffsetX = r*0.35;
    const eyeOffsetY = r*0.1;
    const eyeR = Math.max(2, r*0.09);
    ctx.fillStyle = '#2a2a2a';
    // eyes
    ctx.beginPath();
    ctx.arc(x-eyeOffsetX, y-eyeOffsetY, eyeR, 0, Math.PI*2);
    ctx.arc(x+eyeOffsetX, y-eyeOffsetY, eyeR, 0, Math.PI*2);
    ctx.fill();
    // smile
    ctx.beginPath();
    ctx.lineWidth = Math.max(1.5, r*0.08);
    ctx.strokeStyle = '#2a2a2a';
    const mx = x, my = y + r*0.2;
    ctx.arc(mx, my, r*0.22, Math.PI*0.1, Math.PI*0.9);
    ctx.stroke();
    // cheeks
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ff8aa8';
    ctx.beginPath(); ctx.arc(x-eyeOffsetX*1.2, y+eyeOffsetY*0.6, eyeR*1.1, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x+eyeOffsetX*1.2, y+eyeOffsetY*0.6, eyeR*1.1, 0, Math.PI*2); ctx.fill();

    ctx.restore();
  }

  function drawBear(x,y,r,isGhost){
    // colors（画像が無い場合のフォールバック描画）
    const base = '#c49364';
    const earOuter = '#b07a4c';
    const earInner = '#e8c9a6';
    const muzzle = '#f2dfc7';
    // 影は drawEntity 側で描画済み

    // ears
    const earR = r*0.38;
    const earDx = r*0.55;
    const earDy = r*0.58;
    for (const s of [-1,1]){
      const ex = x + s*earDx;
      const ey = y - earDy;
      ctx.save();
      ctx.beginPath(); ctx.arc(ex,ey,earR,0,Math.PI*2);
      ctx.fillStyle = earOuter; ctx.fill();
      ctx.beginPath(); ctx.arc(ex,ey,earR*0.6,0,Math.PI*2);
      ctx.fillStyle = earInner; ctx.fill();
      ctx.restore();
    }

    // head
    ctx.save();
    const grad = ctx.createRadialGradient(x-r*0.4, y-r*0.6, r*0.3, x, y, r);
    grad.addColorStop(0, lighten(base, .12));
    grad.addColorStop(1, base);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();

    // muzzle
    ctx.beginPath();
    ctx.ellipse(x, y + r*0.15, r*0.55, r*0.38, 0, 0, Math.PI*2);
    ctx.fillStyle = muzzle; ctx.fill();

    // eyes
    const eyeR = Math.max(2, r*0.09);
    const eyeOffsetX = r*0.3; const eyeOffsetY = r*0.05;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.arc(x-eyeOffsetX, y-eyeOffsetY, eyeR, 0, Math.PI*2);
    ctx.arc(x+eyeOffsetX, y-eyeOffsetY, eyeR, 0, Math.PI*2);
    ctx.fill();

    // nose
    ctx.beginPath();
    ctx.arc(x, y + r*0.12, eyeR*0.9, 0, Math.PI*2);
    ctx.fillStyle = '#2a2a2a'; ctx.fill();

    // mouth
    ctx.beginPath();
    ctx.lineWidth = Math.max(1.2, r*0.06);
    ctx.strokeStyle = '#2a2a2a';
    ctx.moveTo(x, y + r*0.18);
    ctx.quadraticCurveTo(x, y + r*0.26, x - r*0.18, y + r*0.26);
    ctx.moveTo(x, y + r*0.18);
    ctx.quadraticCurveTo(x, y + r*0.26, x + r*0.18, y + r*0.26);
    ctx.stroke();

    // cheeks
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#ff8aa8';
    ctx.beginPath(); ctx.arc(x-r*0.42, y+r*0.05, eyeR*1.2, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x+r*0.42, y+r*0.05, eyeR*1.2, 0, Math.PI*2); ctx.fill();

    ctx.restore();
  }

  function lighten(col, amt){
    // expects #rrggbb
    const r = parseInt(col.slice(1,3),16);
    const g = parseInt(col.slice(3,5),16);
    const b = parseInt(col.slice(5,7),16);
    const mix = (v)=> Math.max(0, Math.min(255, Math.round(v + (255-v)*amt)));
    return `#${mix(r).toString(16).padStart(2,'0')}${mix(g).toString(16).padStart(2,'0')}${mix(b).toString(16).padStart(2,'0')}`;
  }

  // Input wiring
  function onMove(clientX){
    const rect = canvas.getBoundingClientRect();
    spawnX = ((clientX - rect.left) / rect.width) * W;
  }
  function drop(){
    const r = LEVELS[nextLevel].radius;
    const x = clamp(spawnX, 12+r, W-12-r);
    spawnFruit(nextLevel, x);
    nextLevel = randNextLevel();
  }

  function setupInput(){
    const supportsPointer = 'onpointerdown' in window;
    if (supportsPointer){
      canvas.addEventListener('pointerdown', (e)=>{
        if (gameOver) return;
        pointerActive = true;
        onMove(e.clientX);
      });
      canvas.addEventListener('pointermove', (e)=>{
        if (!pointerActive || gameOver) return;
        onMove(e.clientX);
      });
      window.addEventListener('pointerup', ()=>{
        if (!pointerActive || gameOver) return;
        pointerActive = false;
        drop();
      });
    } else {
      // Touch fallback
      canvas.addEventListener('touchstart', (e)=>{
        if (gameOver) return; e.preventDefault();
        pointerActive = true;
        const t = e.touches[0]; if (t) onMove(t.clientX);
      }, {passive:false});
      canvas.addEventListener('touchmove', (e)=>{
        if (!pointerActive || gameOver) return; e.preventDefault();
        const t = e.touches[0]; if (t) onMove(t.clientX);
      }, {passive:false});
      window.addEventListener('touchend', (e)=>{
        if (!pointerActive || gameOver) return; e.preventDefault();
        pointerActive = false; drop();
      }, {passive:false});
      // Mouse fallback
      canvas.addEventListener('mousedown', (e)=>{
        if (gameOver) return;
        pointerActive = true; onMove(e.clientX);
      });
      window.addEventListener('mousemove', (e)=>{
        if (!pointerActive || gameOver) return; onMove(e.clientX);
      });
      window.addEventListener('mouseup', ()=>{
        if (!pointerActive || gameOver) return; pointerActive = false; drop();
      });
    }
  }

  restartBtn.addEventListener('click', ()=>{
    resetGame();
  });

  function resetGame(){
    saveBest();
    fruits = [];
    score = 0; scoreEl.textContent = '0';
    nextLevel = randNextLevel();
    overTimer = 0; gameOver = false; overlay.hidden = true;
  }

  // Start loop and input
  setupInput();
  preloadBearImages();
  requestAnimationFrame(frame);

  // 画像読み込み（任意）。assets/bear-0.png ... bear-9.png があれば使用
  function preloadBearImages(){
    for (let i=0;i<LEVELS.length;i++){
      const img = new Image();
      img.onload = () => {
        const spr = trimImage(img);
        bearSprites[i] = spr;
      };
      img.onerror = () => { /* フォールバックで描画 */ };
      img.src = `${ASSET_PATH}/bear-${i}.png`;
    }
  }

  function trimImage(img){
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.clearRect(0,0,w,h);
    octx.drawImage(img, 0,0);
    try{
      const data = octx.getImageData(0,0,w,h).data;
      let minX=w, minY=h, maxX=-1, maxY=-1;
      for (let y=0;y<h;y++){
        for (let x=0;x<w;x++){
          const a = data[(y*w + x)*4 + 3];
          if (a > TRIM_ALPHA_THRESHOLD){
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= minX && maxY >= minY){
        const sx = minX, sy = minY;
        const sw = (maxX - minX + 1);
        const sh = (maxY - minY + 1);
        return { img, sx, sy, sw, sh };
      }
    } catch(e){
      // 失敗時はフルサイズ使用
    }
    return { img, sx:0, sy:0, sw:w, sh:h };
  }

  // （配置ボタン関連のコードは削除）
})();
