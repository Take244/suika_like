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
  const H = 640; // height
  canvas.width = W; canvas.height = H;

  // Safe area for spawning and top line
  const TOP_LINE_Y = 90; // where the red line is drawn
  const SPAWN_Y = 40;    // y position to preview/spawn above line

  // Physics params
  const GRAVITY = 2000;        // px/s^2
  const DAMPING = 0.995;       // velocity damping each step
  const RESTITUTION = 0.25;    // bounciness
  const WALL_RESTITUTION = 0.2;
  const MERGE_OVERLAP_FACTOR = 0.9; // how deep overlap triggers merge
  const MERGE_COOLDOWN = 0.25; // seconds after spawn/merge to avoid instant re-merge

  // Fruit levels (cute pastel colors). Radii in pixels.
  const LEVELS = [
    { name: 'Cherry',     radius: 14, color: '#ff8aa8', score: 1 },
    { name: 'Strawberry', radius: 18, color: '#ff6f91', score: 3 },
    { name: 'Grape',      radius: 22, color: '#b085f5', score: 6 },
    { name: 'Orange',     radius: 28, color: '#ffb75e', score: 10 },
    { name: 'Apple',      radius: 34, color: '#ff8f6b', score: 15 },
    { name: 'Pear',       radius: 42, color: '#9be15d', score: 22 },
    { name: 'Peach',      radius: 52, color: '#ffcad4', score: 32 },
    { name: 'Pineapple',  radius: 64, color: '#ffe873', score: 46 },
    { name: 'Melon',      radius: 80, color: '#a0f0b7', score: 64 },
    { name: 'Watermelon', radius: 98, color: '#7bd389', score: 88 },
  ];

  const START_MAX_LEVEL = 4; // random next is from [0..START_MAX_LEVEL]

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

  function randNextLevel(){
    return Math.floor(Math.random() * (START_MAX_LEVEL + 1));
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
      this.r = LEVELS[level].radius;
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
    const f = new Fruit(level, clamp(x, 20, W-20), TOP_LINE_Y - 8);
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
      if (f.x - f.r < left) { f.x = left + f.r; f.vx = Math.abs(f.vx) * WALL_RESTITUTION; }
      if (f.x + f.r > right){ f.x = right - f.r; f.vx = -Math.abs(f.vx) * WALL_RESTITUTION; }
      // floor
      if (f.y + f.r > bottom){ f.y = bottom - f.r; f.vy = -Math.abs(f.vy) * WALL_RESTITUTION; }
    }

    // Pairwise circle collisions (impulse + positional correction)
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
          // positional correction (split by mass ~ area ~ r^2)
          const overlap = r - d;
          const ma = a.r*a.r, mb = b.r*b.r; const msum = ma + mb;
          const corrA = overlap * (mb/msum);
          const corrB = overlap * (ma/msum);
          a.x -= nx * corrA; a.y -= ny * corrA;
          b.x += nx * corrB; b.y += ny * corrB;
          // relative velocity
          const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
          const velAlongNormal = rvx*nx + rvy*ny;
          if (velAlongNormal < 0){
            const e = RESTITUTION;
            const jimp = -(1+e) * velAlongNormal / (1/ma + 1/mb);
            const impX = jimp * nx, impY = jimp * ny;
            a.vx -= impX / ma; a.vy -= impY / ma;
            b.vx += impX / mb; b.vy += impY / mb;
          }
        }
      }
    }

    // Merge detection queue
    const toMerge = [];
    for (let i=0;i<fruits.length;i++){
      for (let j=i+1;j<fruits.length;j++){
        const a = fruits[i], b = fruits[j];
        if (a.level !== b.level) continue;
        if (a.justBorn > 0 || b.justBorn > 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rsum = a.r + b.r;
        const d2 = dx*dx + dy*dy;
        if (d2 <= 0) continue;
        if (d2 < (rsum*MERGE_OVERLAP_FACTOR)*(rsum*MERGE_OVERLAP_FACTOR)){
          toMerge.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
        }
      }
    }
    // Deduplicate pairs by first fruit id, so each fruit merges once per step
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
        const level = Math.min(a.level+1, LEVELS.length-1);
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
    }

    // Game over check: any fruit top beyond TOP_LINE_Y continuously
    let violating = false;
    for (const f of fruits){
      if (f.y - f.r <= TOP_LINE_Y) { violating = true; break; }
    }
    const ms = FIXED_DT*1000;
    if (violating) overTimer += ms; else overTimer = Math.max(0, overTimer - ms*2);
    if (overTimer > 1000) { triggerGameOver(); }
  }

  function triggerGameOver(){
    if (gameOver) return;
    gameOver = true;
    finalScoreEl.textContent = String(score);
    overlay.hidden = false;
    saveBest();
  }

  // Drawing
  function draw(){
    // clear
    ctx.clearRect(0,0,W,H);

    // playfield background
    drawContainer();

    // preview next fruit
    drawPreview();

    // fruits
    for (const f of fruits){
      drawFruit(f);
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
    const x = clamp(spawnX, 12+r, W-12-r);
    const y = SPAWN_Y;
    ctx.save();
    ctx.globalAlpha = 0.45;
    drawFruitLike(x,y,r,LEVELS[level].color,true);
    ctx.restore();
  }

  function drawFruit(f){
    drawFruitLike(f.x, f.y, f.r, LEVELS[f.level].color, false);
  }

  function drawFruitLike(x,y,r,color,isGhost){
    // shadow
    ctx.save();
    ctx.beginPath();
    const sh = Math.max(2, r*0.2);
    ctx.ellipse(x, Math.min(H-6, y + r - 2), r*0.9, sh, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fill();
    ctx.restore();

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
  requestAnimationFrame(frame);
})();
