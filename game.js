(() => {
  "use strict";

  // O mundo usa coordenadas próprias: o CSS pode redimensionar o Canvas.
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const ui = Object.fromEntries([
    "overlay", "screen-tag", "screen-title", "screen-description", "screen-hint",
    "primary", "secondary", "pause", "restart", "rings", "lives",
    "progress", "progress-fill", "progress-text", "toast"
  ].map(id => [id, document.getElementById(id)]));

  let WIDTH = 960;
  const HEIGHT = 540;
  const WORLD_WIDTH = 5800;
  const FINISH_X = 5600;
  const FLOOR = 440;
  const PHYSICS = { gravity: 1550, acceleration: 1500, friction: 1800, speed: 390, jump: 610 };
  const STATUS = { menu: "menu", playing: "playing", paused: "paused", won: "won", lost: "lost" };
  const keys = new Set();
  const touchKeys = new Map();
  const touchControls = document.querySelector(".touch-controls");
  const touchLayout = window.matchMedia("(pointer: coarse), (max-width: 700px)");
  const isHeld = code => keys.has(code) || [...touchKeys.values()].includes(code);
  function clearTouch() {
    touchKeys.clear();
    touchControls.querySelectorAll("button").forEach(button => button.classList.remove("pressed"));
  }
  function updateTouchHints() {
    ui["screen-hint"].innerHTML = touchLayout.matches
      ? "Use as setas na tela para mover, olhar e rolar.<br>Segure Saltar para um salto mais alto.<br>Cada vilão derrotado: +10 anéis"
      : "← → Mover · ↑ Olhar · ↓ Agachar/rolar<br>Espaço Saltar · Enter Pausa · Esc Início<br>Cada vilão derrotado: +10 anéis";
    clearTouch();
  }
  touchLayout.addEventListener("change", updateTouchHints);
  updateTouchHints();
  touchControls.querySelectorAll("button").forEach(button => {
    button.addEventListener("contextmenu", event => event.preventDefault());
    button.addEventListener("pointerdown", event => {
      if (state !== STATUS.playing || event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      touchKeys.set(event.pointerId, button.dataset.key);
      button.classList.add("pressed");
      if (button.dataset.key === "Space") jumpQueued = true;
    });
    const release = event => {
      touchKeys.delete(event.pointerId);
      if (![...touchKeys.values()].includes(button.dataset.key)) button.classList.remove("pressed");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });
  // Quadros do Sonic no atlas fornecido: x, y, largura, altura.
  // O PNG original é mantido inteiro, incluindo seus créditos.
  const sonicFrames = {
    idle: [[0, 20, 40, 48]],
    run: Array.from({ length: 5 }, (_, i) => [i * 40, 70, 40, 44]),
    spin: Array.from({ length: 5 }, (_, i) => [i * 40, 160, 40, 44]),
    crouch: [[0, 160, 40, 44]]
  };
  // Centraliza o carregamento e o estado dos arquivos de imagem.
  // Carrega uma imagem e expõe uma consulta simples para saber se ela terminou de carregar.
  function loadImage(source, onError) {
    const image = new Image();
    let ready = false;
    image.onload = () => { ready = true; };
    if (onError) image.onerror = onError;
    image.src = source;
    return { image, isReady: () => ready };
  }

  const sonicAsset = loadImage("assets/player.png", () => {
    notify("Não foi possível carregar assets/player.png. Recarregue a página.", 10);
  });
  const enemyAsset = loadImage("assets/mini-vilao.png");
  const defeatedAsset = loadImage("assets/vilao-derrotado.png");
  const sonicImage = sonicAsset.image;
  const enemyImage = enemyAsset.image;
  const defeatedImage = defeatedAsset.image;
  const DEFEAT_DURATION = 1.6;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = STATUS.menu;
  let player, platforms, rings, enemies, particles;
  let collected = 0, lives = 3, camera = 0, cameraY = 0;
  let gameTime = 0, toastTime = 0, lastTime = 0, accumulator = 0;
  let jumpQueued = false;
  let progress = 0;
  const STEP = 1 / 120;
  // Mantém um valor dentro dos limites mínimo e máximo informados.
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  // Aproxima um valor do alvo gradualmente, evitando mudanças bruscas.
  const approach = (value, target, amount) =>
    value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);
  // Verifica se duas áreas retangulares estão se sobrepondo.
  const overlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Fábricas mantêm a estrutura das entidades em um único lugar.
  // Cria um anel com estado inicial disponível para coleta.
  function createRing(x, y) {
    return { x, y, taken: false };
  }

  // Cria um inimigo adicionando dimensões, direção e estado padrão.
  function createEnemy(enemy, index) {
    return {
      ...enemy,
      y: FLOOR - 62,
      w: 48,
      h: 56,
      direction: index % 2 ? -1 : 1,
      alive: true,
      phase: index
    };
  }

  // Cria o jogador com posição, física e estados iniciais.
  function createPlayer(invulnerable = 0) {
    return {
      x: 100,
      y: FLOOR - 44,
      w: 28,
      h: 44,
      vx: 0,
      vy: 0,
      facing: 1,
      grounded: true,
      rolling: false,
      crouching: false,
      invulnerable,
      coyote: .1,
      jumpBuffer: 0,
      hurt: 0
    };
  }

  // Adiciona vários anéis alinhados horizontalmente ao nível atual.
  function addRingLine(x, y, count, spacing = 38) {
    for (let i = 0; i < count; i++) {
      rings.push(createRing(x + i * spacing, y));
    }
  }

  // Monta as plataformas, anéis e inimigos da fase principal.
  function makeLevel() {
    // Buracos curtos e plataformas atravessáveis por baixo.
    platforms = [
      { x: 0, y: FLOOR, w: 1320, h: 240, ground: true },
      { x: 1450, y: FLOOR, w: 1240, h: 240, ground: true },
      { x: 2820, y: FLOOR, w: 1260, h: 240, ground: true },
      { x: 4210, y: FLOOR, w: 1590, h: 240, ground: true },
      { x: 600, y: 345, w: 180, h: 28 },
      { x: 890, y: 260, w: 220, h: 28 },
      { x: 1190, y: 225, w: 210, h: 28 },
      { x: 1510, y: 300, w: 210, h: 28 },
      { x: 2060, y: 345, w: 200, h: 28 },
      { x: 2390, y: 265, w: 220, h: 28 },
      { x: 2740, y: 225, w: 200, h: 28 },
      { x: 3050, y: 310, w: 230, h: 28 },
      { x: 3690, y: 340, w: 190, h: 28 },
      { x: 3960, y: 250, w: 220, h: 28 },
      { x: 4320, y: 300, w: 200, h: 28 },
      { x: 4920, y: 340, w: 240, h: 28 }
    ];
    rings = [];
    addRingLine(270, 396, 7);
    addRingLine(660, 303, 3);
    addRingLine(925, 218, 4);
    addRingLine(1225, 183, 4);
    addRingLine(1560, 258, 3);
    addRingLine(1650, 396, 6);
    addRingLine(2100, 303, 4);
    addRingLine(2430, 223, 4);
    addRingLine(2770, 183, 4);
    addRingLine(3100, 268, 4);
    addRingLine(3210, 396, 6);
    addRingLine(3730, 298, 3);
    addRingLine(4000, 208, 4);
    addRingLine(4350, 258, 4);
    addRingLine(4430, 396, 5);
    addRingLine(4960, 298, 5);
    addRingLine(5350, 396, 5);
    enemies = [
      { x: 1050, min: 960, max: 1200 },
      { x: 1900, min: 1850, max: 2020 },
      { x: 2470, min: 2350, max: 2570 },
      { x: 3510, min: 3420, max: 3610 },
      { x: 4620, min: 4520, max: 4770 },
      { x: 5290, min: 5220, max: 5410 }
    ].map(createEnemy);
  }

  // Posiciona o jogador no início e reinicia câmera e comandos pendentes.
  function spawnPlayer(invulnerable = 0) {
    player = createPlayer(invulnerable);
    keys.clear(); clearTouch();
    jumpQueued = false;
    camera = 0;
    cameraY = 0;
  }

  // Reinicia a partida, restaurando vidas, pontuação e elementos da fase.
  function newGame() {
    makeLevel();
    collected = 0; lives = 3; gameTime = 0;
    particles = []; progress = 0; toastTime = 0;
    ui.toast.classList.remove("visible");
    spawnPlayer();
    changeState(STATUS.playing);
    notify(touchLayout.matches ? "Use as setas e o botão Saltar na tela." : "Setas para mover e Espaço para saltar.", 5);
    updateHUD();
  }

  // Troca o estado do jogo e atualiza a tela correspondente da interface.
  function changeState(next) {
    state = next;
    ui.overlay.classList.toggle("menu-screen", next === STATUS.menu);
    keys.clear(); clearTouch();
    jumpQueued = false;
    player.jumpBuffer = 0;
    accumulator = 0;
    const playing = next === STATUS.playing;
    ui.overlay.hidden = playing;
    touchControls.hidden = !playing;
    ui.pause.disabled = ![STATUS.playing, STATUS.paused].includes(next);
    ui.pause.textContent = next === STATUS.paused ? "▷" : "Ⅱ";
    ui.pause.setAttribute("aria-label", next === STATUS.paused ? "Retomar partida" : "Pausar partida");
    ui.secondary.hidden = next === STATUS.menu;
    ui["screen-hint"].hidden = next !== STATUS.menu;
    const screens = {
      menu: ["GREEN HILL", "liberty",
        "Corra pelos mares de morros, colete anéis e destrua os vilões. Alcance a placa de chegada com suas vidas intactas.", "Jogar →"],
      paused: ["liberty", "Partida pausada",
        "Pressione Enter ou use o botão abaixo para continuar.", "Continuar →"],
      won: ["liberty", "Jogo concluído", "Você chegou ao final com " + collected + " anéis e " + lives + " vida(s).", "Jogar novamente →"],
      lost: ["liberty", "Fim de partida",
        "Suas três vidas acabaram. Pontuação: " + collected + " anéis.", "Reiniciar →"]
    };
    if (playing) {
      canvas.focus({ preventScroll: true });
    } else {
      const [tag, title, description, button] = screens[next];
      ui["screen-tag"].textContent = tag;
      ui["screen-title"].textContent = title;
      ui["screen-description"].textContent = description;
      ui.primary.textContent = button;
      ui.primary.focus({ preventScroll: true });
    }
  }

  // Retorna ao menu inicial e restaura os valores padrão da partida.
  function returnToMenu() {
    makeLevel();
    particles = []; collected = 0; lives = 3;
    gameTime = 0; progress = 0; toastTime = 0;
    ui.toast.classList.remove("visible");
    spawnPlayer();
    changeState(STATUS.menu);
    updateHUD();
  }

  // Alterna entre os estados jogando e pausado.
  function togglePause() {
    if (state === STATUS.playing) changeState(STATUS.paused);
    else if (state === STATUS.paused) changeState(STATUS.playing);
  }

  // Exibe uma mensagem temporária no aviso visual da interface.
  function notify(message, duration = 2.5) {
    ui.toast.textContent = message;
    ui.toast.classList.add("visible");
    toastTime = duration;
  }

  // Atualiza no HTML os anéis, vidas e progresso da fase.
  function updateHUD() {
    ui.rings.textContent = String(collected).padStart(2, "0");
    ui.lives.textContent = String(lives).padStart(2, "0");
    progress = state === STATUS.won ? 100 : Math.round(clamp((player.x - 100) / (FINISH_X - 100), 0, 1) * 100);
    ui["progress-fill"].style.width = progress + "%";
    ui.progress.setAttribute("aria-valuenow", progress);
    ui["progress-text"].textContent = progress + "% DO PERCURSO";
  }

  // Cria partículas radiais para representar coleta, dano ou derrota.
  function burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2;
      particles.push({ x, y, vx: Math.cos(angle) * (90 + Math.random() * 80),
        vy: Math.sin(angle) * 150 - 70, life: .65, maxLife: .65, color });
    }
  }

  // Remove uma vida e encerra ou reinicia a tentativa do jogador.
  function loseLife() {
    lives--;
    collected = 0;
    if (lives <= 0) {
      changeState(STATUS.lost);
    } else {
      spawnPlayer(2);
      notify("Você perdeu uma vida. Restam " + lives + ". Tente outro caminho!", 3.5);
    }
    updateHUD();
  }

  // Processa o dano causado por um inimigo, removendo anéis ou vidas.
  function takeDamage(enemy) {
    if (player.invulnerable > 0) return;
    if (collected === 0) { loseLife(); return; }
    burst(player.x + 14, player.y + 20, "#ffd346", 18);
    collected = 0;
    player.invulnerable = 2;
    player.hurt = .25;
    player.vx = player.x < enemy.x ? -240 : 240;
    player.vy = -320;
    player.grounded = false;
    notify("Você perdeu os anéis! Aproveite a breve proteção.");
  }

  // Atualiza física, controles, colisões, inimigos, câmera e regras da partida.
  function update(dt) {
    gameTime += dt;
    const p = player;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.hurt = Math.max(0, p.hurt - dt);
    p.coyote = p.grounded ? .09 : Math.max(0, p.coyote - dt);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    if (jumpQueued) { p.jumpBuffer = .12; jumpQueued = false; }
    const movement = Number(isHeld("ArrowRight")) - Number(isHeld("ArrowLeft"));
    p.rolling = isHeld("ArrowDown") && p.grounded && Math.abs(p.vx) > 95;
    p.crouching = isHeld("ArrowDown") && p.grounded && !p.rolling;
    if (p.hurt === 0) {
      if (movement && !p.crouching && !p.rolling) {
        p.vx = approach(p.vx, movement * PHYSICS.speed, PHYSICS.acceleration * dt);
        p.facing = movement;
      } else {
        p.vx = approach(p.vx, 0, (p.rolling ? 180 : PHYSICS.friction) * dt);
      }
    }
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vy = -PHYSICS.jump;
      p.grounded = false; p.coyote = 0; p.jumpBuffer = 0;
    }
    // O salto continua enquanto o espaço é mantido; soltar encurta a subida.
    if (!isHeld("Space") && p.vy < -230) p.vy += 1800 * dt;
    const previousBottom = p.y + p.h;
    p.x = clamp(p.x + p.vx * dt, 0, WORLD_WIDTH - p.w);
    p.vy = Math.min(900, p.vy + PHYSICS.gravity * dt);
    p.y += p.vy * dt;
    p.grounded = false;
    for (const platform of platforms) {
      if (p.vy >= 0 && previousBottom <= platform.y + 1 &&
          p.y + p.h >= platform.y && p.x + p.w > platform.x && p.x < platform.x + platform.w) {
        p.y = platform.y - p.h;
        p.vy = 0;
        p.grounded = true;
      }
    }
    if (p.y > HEIGHT + 100) { loseLife(); return; }
    for (const ring of rings) {
      if (!ring.taken && overlap(p, { x: ring.x - 11, y: ring.y - 13, w: 22, h: 26 })) {
        ring.taken = true; collected++;
        burst(ring.x, ring.y, "#fff18d", 5);
      }
    }
    for (const enemy of enemies) {
      if (!enemy.alive) {
        enemy.defeatTime = Math.max(0, (enemy.defeatTime || 0) - dt);
        continue;
      }
      enemy.x += enemy.direction * 52 * dt;
      if (enemy.x <= enemy.min || enemy.x >= enemy.max) {
        enemy.x = clamp(enemy.x, enemy.min, enemy.max);
        enemy.direction *= -1;
      }
      if (!overlap(p, enemy)) continue;
      if (p.vy > 0 && previousBottom <= enemy.y + 16) {
        enemy.alive = false;
        enemy.defeatTime = DEFEAT_DURATION;
        collected += 10;
        p.vy = -430; p.grounded = false;
        burst(enemy.x + 24, enemy.y + 25, "#ffb66d", 16);
        notify("Vilão derrotado! +10 anéis", 1.4);
      } else {
        const beforeLives = lives;
        takeDamage(enemy);
        if (lives !== beforeLives) return;
      }
    }
    for (const particle of particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 420 * dt;
      particle.life -= dt;
    }
    particles = particles.filter(particle => particle.life > 0);
    camera = approach(camera, clamp(p.x - WIDTH * .32, 0, Math.max(0, WORLD_WIDTH - WIDTH)), Math.max(1000, Math.abs(p.vx) + 200) * dt);
    const lookUp = p.grounded && Math.abs(p.vx) < 10 && isHeld("ArrowUp");
    cameraY = approach(cameraY, lookUp ? -75 : 0, 160 * dt);
    if (toastTime > 0) {
      toastTime -= dt;
      if (toastTime <= 0) ui.toast.classList.remove("visible");
    }
    if (p.x >= FINISH_X) {
      notify("Green Hill concluída!", 3);
      changeState(STATUS.won);
    }
    updateHUD();
  }

  // Desenho procedural: cenário e herói não dependem de downloads externos.
  // Desenha um retângulo preenchido no Canvas.
  function rect(x, y, w, h, color) {
    ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  }
  // Desenha uma elipse preenchida no Canvas.
  function ellipse(x, y, rx, ry, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Desenha um polígono preenchido a partir de uma lista de pontos.
  function polygon(points, color) {
    ctx.fillStyle = color; ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath(); ctx.fill();
  }
  // Desenha uma linha conectando os pontos informados.
  function line(points, color, width = 2) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
  }
  // Desenha um texto formatado no Canvas.
  function text(label, x, y, size, color, align = "left") {
    ctx.fillStyle = color; ctx.font = "bold " + size + "px monospace"; ctx.textAlign = align;
    ctx.fillText(label, x, y);
  }

  // Desenha o céu, sol, nuvens, montanhas, vegetação e água do cenário.
  function drawBackground() {
    const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    sky.addColorStop(0, "#71cbdc"); sky.addColorStop(.65, "#c4ebe0"); sky.addColorStop(1, "#f1f0be");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ellipse(760 - camera * .015, 92, 38, 38, "#fff4b5");
    ellipse(760 - camera * .015, 92, 48, 48, "#fff4b520");
    for (let i = -1; i < 10; i++) {
      const x = i * 250 - (camera * .1 % 250);
      const y = 75 + (i % 3) * 35;
      rect(x, y, 110, 13, "#effaf0"); rect(x + 20, y - 12, 70, 16, "#effaf0");
      rect(x + 44, y - 21, 28, 13, "#effaf0");
    }
    for (let i = -1; i < 8; i++) {
      const x = i * 260 - (camera * .18 % 260);
      polygon([[x, 380], [x + 35, 240], [x + 110, 167], [x + 185, 258], [x + 280, 380]], "#6ab5a8");
      polygon([[x + 110, 167], [x + 127, 277], [x + 185, 258]], "#8ccbbb");
      polygon([[x + 110, 167], [x + 80, 202], [x + 120, 211]], "#d3e9c4");
    }
    for (let i = -1; i < 8; i++) {
      const x = i * 220 - (camera * .35 % 220);
      ellipse(x + 100, 391, 156, 88 + (i % 2) * 22, "#428f78");
      ellipse(x + 145, 400, 118, 57, "#64a975");
    }
    rect(0, 395, WIDTH, 145, "#59bfc0");
    for (let i = 0; i < 12; i++) {
      const x = ((i * 109 - camera * .5) % (WIDTH + 100) + WIDTH + 100) % (WIDTH + 100);
      rect(x, 410 + (i % 5) * 24, 35 + (i % 3) * 10, 2, "#b3e4c87a");
    }
  }

  // Desenha uma palmeira em uma posição e escala específicas.
  function drawPalm(x, y, size = 1) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    polygon([[-8, 0], [9, 0], [20, -128], [8, -132]], "#8c6440");
    for (let i = 0; i < 8; i++) line([[-5 + i * 1.6, -i * 16], [10 + i * 1.2, -i * 16 - 4]], "#b98b50", 4);
    const top = -133;
    polygon([[13, top], [-31, top - 31], [-77, top - 19], [-101, top + 9], [-51, top - 7]], "#24744b");
    polygon([[13, top], [-8, top - 52], [-46, top - 65], [-60, top - 51], [-19, top - 29]], "#45963e");
    polygon([[13, top], [39, top - 53], [74, top - 61], [58, top - 37]], "#3c913c");
    polygon([[13, top], [68, top - 32], [111, top + 2], [115, top + 24], [69, top - 6]], "#286f45");
    polygon([[13, top], [52, top - 11], [77, top + 37], [45, top + 12]], "#53a846");
    ellipse(14, top + 5, 10, 10, "#a5743b"); ellipse(29, top + 4, 9, 9, "#805b32");
    ctx.restore();
  }

  // Desenha uma plataforma com textura, grama e detalhes decorativos.
  function drawPlatform(p) {
    const bottom = p.y + p.h;
    rect(p.x, p.y + 9, p.w, p.h - 9, "#ad6f42");
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y + 9, p.w, p.h - 9); ctx.clip();
    const tile = p.ground ? 32 : 18;
    for (let y = p.y + 9, row = 0; y < bottom; y += tile, row++) {
      for (let x = p.x, col = 0; x < p.x + p.w; x += tile, col++) {
        if ((row + col) % 2 === 0) rect(x, y, tile, tile, "#915a3c");
      }
    }
    ctx.restore();
    rect(p.x, p.y, p.w, 7, "#b0d94d");
    rect(p.x, p.y + 7, p.w, 8, "#5b9d3b");
    for (let x = p.x; x < p.x + p.w - 8; x += 16) {
      rect(x, p.y + 15, 8, 4, "#5b9d3b");
      rect(x + 3, p.y - 3, 2, 4, "#b0d94d");
    }
  }

  // Desenha um anel com animação de oscilação horizontal.
  function drawRing(ring) {
    const squeeze = .72 + Math.sin(gameTime * 4 + ring.x) * .22;
    ctx.save(); ctx.translate(ring.x, ring.y + Math.sin(gameTime * 3 + ring.x) * 2);
    ctx.scale(squeeze, 1);
    ctx.lineWidth = 4; ctx.strokeStyle = "#9d6b21"; ctx.beginPath(); ctx.ellipse(1, 1, 8, 11, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#ffe260"; ctx.beginPath(); ctx.ellipse(0, 0, 8, 11, 0, 0, Math.PI * 2); ctx.stroke();
    rect(-4, -9, 4, 3, "#fff7b2"); ctx.restore();
  }

  // Seleciona o frame adequado e desenha o jogador conforme seu estado.
  function drawHero() {
    const p = player;
    if (!sonicAsset.isReady()) return;
    if (p.invulnerable > 0 && Math.floor(gameTime * 14) % 2) return;
    const spinning = !p.grounded || p.rolling;
    const animation = spinning ? "spin" : p.crouching ? "crouch"
      : Math.abs(p.vx) > 15 ? "run" : "idle";
    const frames = sonicFrames[animation];
    const fps = spinning ? 16 : Math.min(20, 8 + Math.abs(p.vx) / 45);
    const frame = frames[Math.floor(gameTime * fps) % frames.length];
    const [sx, sy, sw, sh] = frame;
    const scale = 1.3;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(p.x + p.w / 2, p.y + p.h);
    ctx.scale(p.facing, 1);
    // Alinha os pés à colisão e espelha a imagem ao mudar de direção.
    ctx.drawImage(sonicImage, sx, sy, sw, sh,
      -sw * scale / 2, -sh * scale + 4, sw * scale, sh * scale);
    ctx.restore();
  }
  // Desenha a animação temporária de um inimigo derrotado.
  function drawDefeatedEnemy(enemy) {
    const elapsed = DEFEAT_DURATION - enemy.defeatTime;
    const fade = Math.min(1, enemy.defeatTime / .55);
    const lift = reducedMotion.matches ? 0 : Math.sin(elapsed / DEFEAT_DURATION * Math.PI) * 15;
    ctx.save();
    ctx.translate(enemy.x + enemy.w / 2, enemy.y + 22 - lift);
    ctx.globalAlpha = fade;
    if (!reducedMotion.matches) ctx.rotate(Math.sin(elapsed * 18) * .065);
    if (defeatedAsset.isReady()) {
      const height = 108;
      const width = height * defeatedImage.naturalWidth / defeatedImage.naturalHeight;
      ctx.drawImage(defeatedImage, -width / 2, -height / 2, width, height);
    } else {
      ctx.translate(-enemy.x - enemy.w / 2, -enemy.y - 22);
      drawEnemy(enemy);
      ctx.translate(enemy.x + enemy.w / 2, enemy.y + 22);
    }
    text("+10 anéis", 0, -65, 13, "#fff18d", "center");
    ctx.restore();
  }
  // Desenha o inimigo usando sua imagem ou uma representação de reserva.
  function drawEnemy(enemy) {
    const bob = Math.sin(gameTime * 4 + enemy.phase) * 3;
    if (enemyAsset.isReady()) {
      // A arte mantém suas proporções e ocupa a área próxima à colisão.
      ctx.drawImage(enemyImage, enemy.x - 10, enemy.y - 15 + bob, 68, 87);
    } else {
      // Alternativa local caso o navegador não consiga carregar o PNG.
      ellipse(enemy.x + 24, enemy.y + 40 + bob, 28, 15, "#404b61");
      ellipse(enemy.x + 24, enemy.y + 15 + bob, 14, 17, "#e9b18a");
      rect(enemy.x + 11, enemy.y + 1 + bob, 26, 7, "#695249");
      rect(enemy.x + 7, enemy.y + 31 + bob, 34, 10, "#9e333d");
      ellipse(enemy.x + 24, enemy.y + 48 + bob, 7, 7, "#ffda55");
    }
  }

  // Coordena a renderização de todos os elementos visíveis do mundo.
  function drawWorld() {
    drawBackground();
    ctx.save(); ctx.translate(-Math.round(camera), -Math.round(cameraY));
    for (const x of [170, 830, 1730, 2230, 3010, 3630, 4450, 5010, 5500]) {
      if (x > camera - 150 && x < camera + WIDTH + 150) drawPalm(x, FLOOR, x % 3 === 0 ? .9 : 1.1);
    }
    for (const p of platforms) {
      if (p.x + p.w > camera && p.x < camera + WIDTH) drawPlatform(p);
    }
    // Flores e pequenas moitas ajudam a marcar o chão seguro.
    for (const ground of platforms.filter(p => p.ground)) {
      for (let x = ground.x + 55; x < ground.x + ground.w - 20; x += 175) {
        if (x < camera - 30 || x > camera + WIDTH + 30) continue;
        line([[x, FLOOR], [x, FLOOR - 24]], "#347947", 3);
        for (let i = 0; i < 7; i++) {
          const angle = i / 7 * Math.PI * 2;
          ellipse(x + Math.cos(angle) * 7, FLOOR - 28 + Math.sin(angle) * 7, 4, 4, "#efce55");
        }
        ellipse(x, FLOOR - 28, 4, 4, "#785c3c");
        polygon([[x + 12, FLOOR], [x + 20, FLOOR - 15], [x + 20, FLOOR], [x + 32, FLOOR - 12], [x + 29, FLOOR]], "#458b46");
      }
    }
    for (const ring of rings) if (!ring.taken && Math.abs(ring.x - camera - WIDTH / 2) < WIDTH / 2 + 20) drawRing(ring);
    // Placas desenhadas no mundo, sem interferir nas colisões.
    for (const x of [1240, 2610, 4000]) {
      rect(x, FLOOR - 35, 3, 35, "#83613e");
      polygon([[x - 13, FLOOR - 34], [x + 17, FLOOR - 34], [x + 2, FLOOR - 57]], "#f4cc55");
      text("!", x + 2, FLOOR - 38, 13, "#6a5032", "center");
    }
    rect(FINISH_X + 22, FLOOR - 145, 7, 145, "#f5eed3");
    rect(FINISH_X - 32, FLOOR - 148, 116, 65, "#244e42");
    rect(FINISH_X - 26, FLOOR - 142, 104, 53, "#e5ebbd");
    text("liberty", FINISH_X + 26, FLOOR - 121, 14, "#244e42", "center");
    text("CHEGADA", FINISH_X + 26, FLOOR - 102, 11, "#244e42", "center");
    for (const enemy of enemies) {
      if (enemy.x < camera - 100 || enemy.x > camera + WIDTH + 100) continue;
      if (enemy.alive) drawEnemy(enemy);
      else if (enemy.defeatTime > 0) drawDefeatedEnemy(enemy);
    }
    drawHero();
    for (const particle of particles) {
      ctx.globalAlpha = particle.life / particle.maxLife;
      rect(particle.x, particle.y, 4, 4, particle.color);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (state === STATUS.won) {
      for (let i = 0; i < 45; i++) {
        rect((i * 137) % WIDTH, (i * 83) % HEIGHT, 5, 9, ["#ffe064", "#f58e69", "#e3f4ba"][i % 3]);
      }
    }
  }

  // Executa um quadro do jogo, atualizando a lógica e redesenhando o Canvas.
  function frame(now) {
    const elapsed = Math.min((now - lastTime) / 1000 || 0, .05);
    lastTime = now;
    if (state === STATUS.playing) {
      accumulator += elapsed;
      while (accumulator >= STEP && state === STATUS.playing) {
        update(STEP);
        accumulator = Math.max(0, accumulator - STEP);
      }
    } else accumulator = 0;
    drawWorld();
    window.requestAnimationFrame(frame);
  }

  const gameKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter", "Escape", "ControlLeft"]);
  // Registra teclas pressionadas e converte comandos em ações do jogo.
  window.addEventListener("keydown", event => {
    if (!gameKeys.has(event.code)) return;
    if (event.code === "Escape") {
      if (state !== STATUS.menu) { event.preventDefault(); returnToMenu(); }
      return;
    }
    if (event.code === "Enter" && [STATUS.playing, STATUS.paused].includes(state)) {
      event.preventDefault();
      if (!event.repeat) togglePause();
      return;
    }
    if (state !== STATUS.playing) return;
    // Preserva a ativação normal de botões se o foco saiu do Canvas.
    if (event.target instanceof HTMLButtonElement && event.code === "Space") return;
    event.preventDefault();
    keys.add(event.code);
    if (event.code === "Space" && !event.repeat) jumpQueued = true;
    if (event.code === "ControlLeft" && !event.repeat) notify("Esta aventura tem um único personagem jogável.");
  });
  // Remove do conjunto as teclas que deixaram de ser pressionadas.
  window.addEventListener("keyup", event => {
    keys.delete(event.code);
    if (state === STATUS.playing && gameKeys.has(event.code)) event.preventDefault();
  });
  // Pausa a partida quando a janela perde o foco.
  window.addEventListener("blur", () => {
    keys.clear(); clearTouch();
    if (state === STATUS.playing) changeState(STATUS.paused);
  });
  // Pausa a partida quando a aba deixa de estar visível.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === STATUS.playing) changeState(STATUS.paused);
  });
  // Controla o botão principal de iniciar, continuar ou reiniciar.
  ui.primary.addEventListener("click", () => {
    if (state === STATUS.paused) changeState(STATUS.playing);
    else newGame();
  });
  // Retorna ao menu quando o botão secundário é acionado.
  ui.secondary.addEventListener("click", returnToMenu);
  // Pausa ou retoma a partida pelo botão da barra superior.
  ui.pause.addEventListener("click", togglePause);
  // Reinicia a fase atual pelo botão de reinício.
  ui.restart.addEventListener("click", () => newGame());

  // Ajusta a largura visível à janela, sem faixas ou distorção do mundo.
  // Redimensiona o Canvas e reposiciona a câmera após mudanças no viewport.
  function resizeViewport() {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    WIDTH = Math.max(1, Math.round(HEIGHT * bounds.width / bounds.height));
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    camera = clamp(player.x - WIDTH * .32, 0, Math.max(0, WORLD_WIDTH - WIDTH));
  }

  makeLevel(); particles = []; spawnPlayer(); updateHUD();
  const viewportObserver = new ResizeObserver(resizeViewport);
  viewportObserver.observe(canvas);
  resizeViewport();
  window.requestAnimationFrame(frame);
})();










