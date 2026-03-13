import * as THREE from 'three';
import { Peer } from 'peerjs';

/**
 * CORE CONSTANTS & SETTINGS
 */
const CONFIG = {
  version: '1.0.0',
  syncRate: 1000 / 20, // 20hz tick rate for networking
  playerSpeed: 10.0,
  playerSpeed: 10.0,
  playerJumpForce: 10.0,  // Snappier jump
  gravity: 30.0,          // Faster fall
  mapBounds: 200,
  playerColors: [0xff0055, 0x00f0ff, 0x33ff77, 0xffaa00, 0xaa00ff, 0xffff00],
  maxHealth: 100,
  damage: 25,
  respawnTime: 3000
};

const WEAPONS = {
  pistol: { name: 'Pistol', damage: 25, mag: 15, fireRate: 150, pellets: 1, spread: 0.02, recoil: 0.3, speed: 60, auto: false },
  rifle: { name: 'Assault Rifle', damage: 15, mag: 30, fireRate: 100, pellets: 1, spread: 0.05, recoil: 0.5, speed: 50, auto: true },
  sniper: { name: 'Sniper Rifle', damage: 90, mag: 5, fireRate: 1500, pellets: 1, spread: 0.001, recoil: 1.5, speed: 120, auto: false },
  shotgun: { name: 'Shotgun', damage: 12, mag: 8, fireRate: 1000, pellets: 8, spread: 0.12, recoil: 1.0, speed: 40, auto: false }
};

/**
 * GAME STATE
 */
const GameState = {
  isHost: false,
  roomCode: null,
  peer: null,        // PeerJS instance
  hostConn: null,    // If client, connection to host
  clientConns: {},   // If host, connections to clients (id -> DataConnection)

  localPlayer: {
    id: null,
    name: 'Player',
    color: 0xffffff,
    health: 100,
    kills: 0,
    deaths: 0,
    isDead: false,

    // Physics / Three.js
    velocity: new THREE.Vector3(),
    onGround: true,
    mesh: null, // The visual body
    weapon: 'rifle',
    ammo: 30
  },

  // other players indexed by peerId
  remotePlayers: {},

  // Bullets
  bullets: [],

  mode: 'ffa', // ffa | tdm | lms
  isActive: false,

  // Input state
  input: {
    forward: false,
    backward: false,
    left: false,
    right: false,
    space: false,
    shift: false,
    mouseDown: false
  }
};

/**
 * UI ELEMENTS REFERENCE
 */
const UI = {
  screens: {
    menu: document.getElementById('screen-menu'),
    lobby: document.getElementById('screen-lobby'),
    hud: document.getElementById('screen-hud')
  },
  menu: {
    username: document.getElementById('username'),
    weaponSelect: document.getElementById('weapon-select'),
    roomCode: document.getElementById('room-code-input'),
    btnHost: document.getElementById('btn-host'),
    btnJoin: document.getElementById('btn-join'),
    status: document.getElementById('connection-status')
  },
  lobby: {
    roomCodeDisplay: document.getElementById('display-room-code'),
    playerList: document.getElementById('lobby-player-list'),
    playerCount: document.getElementById('player-count'),
    modeSelect: document.getElementById('setting-mode'),
    btnLeave: document.getElementById('btn-leave-lobby'),
    btnStart: document.getElementById('btn-start-game'),
    hostOnlyMsg: document.getElementById('host-only-msg')
  },
  hud: {
    health: document.getElementById('health-val'),
    healthBar: document.getElementById('health-bar-fill'),
    ammo: document.getElementById('ammo-val'),
    fps: document.getElementById('fps-val'),
    ping: document.getElementById('ping-val'),
    deathOverlay: document.getElementById('death-overlay'),
    killerName: document.getElementById('killer-name'),
    respawnTimer: document.getElementById('respawn-timer'),
    killfeed: document.getElementById('killfeed'),
    modeIndicator: document.getElementById('hud-mode'),
    leaderboard: document.getElementById('hud-leaderboard'),
    crosshair: document.getElementById('crosshair'),
    scopeOverlay: document.getElementById('scope-overlay')
  },
  clickToLock: document.getElementById('click-to-lock')
};

function switchScreen(screenId) {
  Object.values(UI.screens).forEach(s => s.classList.remove('active'));
  if (UI.screens[screenId]) UI.screens[screenId].classList.add('active');
}

/**
 * NETWORKING LOGIC (PEER.JS)
 */

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function initPeerSession() {
  if (GameState.peer) {
    GameState.peer.destroy();
  }

  const idToRequest = GameState.isHost ? GameState.roomCode : null;
  GameState.peer = new Peer(idToRequest, {
    debug: 2
    // Uses default cloud server for signaling
  });

  GameState.peer.on('open', (id) => {
    GameState.localPlayer.id = id;

    if (GameState.isHost) {
      console.log('Host created room:', id);
      UI.lobby.roomCodeDisplay.innerText = id;
      switchScreen('lobby');
      updateLobbyPlayerList();
    } else {
      console.log('Client got ID:', id, 'Connecting to Host:', GameState.roomCode);
      connectToHost(GameState.roomCode);
    }
  });

  GameState.peer.on('error', (err) => {
    console.error('PeerJS error:', err.type);
    UI.menu.status.innerText = `Error: ${err.type}`;
    if (err.type === 'unavailable-id') {
      UI.menu.status.innerText = 'Room code already exists. Please try again.';
    }
    if (err.type === 'peer-unavailable') {
      UI.menu.status.innerText = 'Room not found. Check the code.';
      switchScreen('menu'); // go back to menu if joining failed
    }
  });

  // If host, accept incoming connections
  if (GameState.isHost) {
    GameState.peer.on('connection', (conn) => {
      console.log('Client connected:', conn.peer);

      conn.on('open', () => {
        GameState.clientConns[conn.peer] = conn;
        setupConnectionHandlers(conn);

        // Broadcast new player list to everyone
        broadcastPlayerList();
      });
    });
  }
}

function connectToHost(hostId) {
  const conn = GameState.peer.connect(hostId);
  UI.menu.status.innerText = 'Connecting...';

  conn.on('open', () => {
    console.log('Connected to Host');
    GameState.hostConn = conn;
    setupConnectionHandlers(conn);

    // Tell the host who we are
    sendToHost({
      type: 'JOIN',
      player: {
        id: GameState.localPlayer.id,
        name: GameState.localPlayer.name,
        color: CONFIG.playerColors[Math.floor(Math.random() * CONFIG.playerColors.length)]
      }
    });

    UI.lobby.roomCodeDisplay.innerText = hostId;
    switchScreen('lobby');
  });
}

function setupConnectionHandlers(conn) {
  conn.on('data', (data) => {
    handleNetworkMessage(data, conn.peer);
  });

  conn.on('close', () => {
    console.log('Connection closed:', conn.peer);
    if (GameState.isHost) {
      delete GameState.clientConns[conn.peer];
      removePlayer(conn.peer);
      broadcastPlayerList();
    } else {
      // Host disconnected
      alert("Host disconnected");
      location.reload();
    }
  });
}

function sendToHost(data) {
  if (GameState.hostConn && GameState.hostConn.open) {
    GameState.hostConn.send(data);
  }
}

function broadcastToClients(data, excludePeerId = null) {
  Object.keys(GameState.clientConns).forEach(peerId => {
    if (peerId !== excludePeerId) {
      const conn = GameState.clientConns[peerId];
      if (conn && conn.open) {
        conn.send(data);
      }
    }
  });
}

// Master network router
function handleNetworkMessage(msg, senderId) {
  switch (msg.type) {
    case 'JOIN':
      if (GameState.isHost) {
        // Add to our list
        addRemotePlayer(msg.player);
        broadcastPlayerList();
      }
      break;

    case 'PLAYER_LIST': // Host sent full state to client
      if (!GameState.isHost) {
        syncRemotePlayers(msg.players);
        updateLobbyPlayerList();
      }
      break;

    case 'START_GAME':
      if (!GameState.isHost) {
        startGameWorld();
      }
      break;

    case 'STATE_SYNC':
      // Receive positions/rotations
      applyStateSync(msg.state);
      // If host, relay to others
      if (GameState.isHost) {
        broadcastToClients(msg, senderId);
      }
      break;

    case 'SHOOT':
      // Handle shooting visual
      spawnNetworkBullet(msg.pos, msg.dir, msg.color, msg.maxDist, msg.speed, msg.wKey);
      if (GameState.isHost) broadcastToClients(msg, senderId);
      break;

    case 'DECAL':
      spawnHitDecal(msg.pos, msg.norm);
      if (GameState.isHost) broadcastToClients(msg, senderId);
      break;

    case 'HIT':
      handlePlayerHit(msg);
      if (GameState.isHost) broadcastToClients(msg, senderId);
      break;

    case 'KILL':
      handleKillFeed(msg.killer, msg.victim);
      if (GameState.isHost) broadcastToClients(msg, senderId);
      break;
  }
}

function addRemotePlayer(pData) {
  GameState.remotePlayers[pData.id] = {
    ...pData,
    health: 100,
    kills: 0,
    deaths: 0,
    mesh: null, // will be created when game starts
    position: new THREE.Vector3(),
    rotation: 0
  };
}

function removePlayer(id) {
  if (GameState.remotePlayers[id]) {
    if (GameState.remotePlayers[id].mesh) {
      scene.remove(GameState.remotePlayers[id].mesh);
    }
    delete GameState.remotePlayers[id];
  }
}

function broadcastPlayerList() {
  const players = {};
  players[GameState.localPlayer.id] = {
    id: GameState.localPlayer.id,
    name: GameState.localPlayer.name,
    color: GameState.localPlayer.color,
    isHost: true
  };

  Object.values(GameState.remotePlayers).forEach(p => {
    players[p.id] = { id: p.id, name: p.name, color: p.color, isHost: false };
  });

  broadcastToClients({
    type: 'PLAYER_LIST',
    players: players
  });

  updateLobbyPlayerList();
}

function syncRemotePlayers(playerDict) {
  // Clear and Re-add existing (simple approach for lobby)
  Object.keys(playerDict).forEach(id => {
    if (id !== GameState.localPlayer.id && !GameState.remotePlayers[id]) {
      addRemotePlayer(playerDict[id]);
    }
  });
}

function updateLobbyPlayerList() {
  UI.lobby.playerList.innerHTML = '';

  let total = 1;
  const rawList = [GameState.localPlayer, ...Object.values(GameState.remotePlayers)];

  rawList.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div style="display:flex; align-items:center; gap: 10px;">
        <div style="width:16px;height:16px;border-radius:50%;background-color:#${p.color.toString(16).padStart(6, '0')}"></div>
        <span>${p.name}</span>
        ${(p.id === (GameState.isHost ? GameState.localPlayer.id : GameState.roomCode)) ? '<span class="player-tag-host">HOST</span>' : ''}
      </div>
    `;
    UI.lobby.playerList.appendChild(li);
    if (p.id !== GameState.localPlayer.id) total++;
  });

  UI.lobby.playerCount.innerText = total;

  if (GameState.isHost) {
    UI.lobby.btnStart.classList.remove('disabled');
    UI.lobby.modeSelect.disabled = false;
    UI.lobby.hostOnlyMsg.style.display = 'none';
  } else {
    UI.lobby.btnStart.classList.add('disabled');
  }
}


/**
 * AUDIO SYSTEM
 */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  if (type === 'shoot_pistol') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(250, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.08);
    gainNode.gain.setValueAtTime(0.04, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
    osc.start(now);
    osc.stop(now + 0.08);
  } else if (type === 'shoot_rifle') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
    gainNode.gain.setValueAtTime(0.06, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  } else if (type === 'shoot_shotgun') {
    // Heavy, scattered boom
    osc.type = 'square';
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.25);
    gainNode.gain.setValueAtTime(0.2, now); // loud
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
    osc.start(now);

    // Add noise burst for shotgun using a second oscillator
    const osc2 = audioCtx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(120, now);
    osc2.frequency.exponentialRampToValueAtTime(10, now + 0.2);
    osc2.connect(gainNode);
    osc2.start(now);
    osc2.stop(now + 0.25);
    osc.stop(now + 0.25);
  } else if (type === 'shoot_sniper') {
    // Sharp, echoing crack
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.3);
    gainNode.gain.setValueAtTime(0.15, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (type === 'hit') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.1);
    gainNode.gain.setValueAtTime(0.1, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  } else if (type === 'jump') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.linearRampToValueAtTime(300, now + 0.15);
    gainNode.gain.setValueAtTime(0.05, now);
    gainNode.gain.linearRampToValueAtTime(0.01, now + 0.15);
    osc.start(now);
    osc.stop(now + 0.15);
  }
}

/**
 * ------------------------------------------------------------------
 * EVENT LISTENERS (UI)
 * ------------------------------------------------------------------
 */

UI.menu.btnHost.addEventListener('click', () => {
  const name = UI.menu.username.value.trim() || 'Guest';
  GameState.localPlayer.name = name;
  GameState.localPlayer.color = CONFIG.playerColors[0]; // Host gets first color
  GameState.isHost = true;
  GameState.roomCode = generateRoomCode();

  initPeerSession();
});

UI.menu.btnJoin.addEventListener('click', () => {
  const name = UI.menu.username.value.trim() || 'Guest';
  const code = UI.menu.roomCode.value.trim().toUpperCase();

  if (code.length !== 6) {
    UI.menu.status.innerText = 'Enter a valid 6-char room code.';
    return;
  }

  GameState.localPlayer.name = name;
  GameState.localPlayer.color = CONFIG.playerColors[Math.floor(Math.random() * CONFIG.playerColors.length)];
  GameState.isHost = false;
  GameState.roomCode = code;

  initPeerSession();
});

UI.lobby.btnLeave.addEventListener('click', () => {
  location.reload();
});

document.getElementById('btn-quit').addEventListener('click', () => {
  location.reload();
});

UI.lobby.btnStart.addEventListener('click', () => {
  if (!GameState.isHost) return;

  broadcastToClients({ type: 'START_GAME', mode: UI.lobby.modeSelect.value });
  GameState.mode = UI.lobby.modeSelect.value;
  startGameWorld();
});


/**
 * ------------------------------------------------------------------
 * THREE.JS ENGINE & GAMEPLAY LOGIC (STUBS FOR NEXT STEP)
 * ------------------------------------------------------------------
 */

let scene, camera, renderer;
let clock;
let mapColliders = [];
let spawnPoints = [];

// Store all water materials to animate them in the main loop
const waterMaterials = [];

// Player Mesh logic
const bodyGeometry = new THREE.BoxGeometry(1, 1.5, 1);
const headGeometry = new THREE.SphereGeometry(0.5, 16, 16);
const bulletGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.6, 8); // Tighter tracer cylinder
bulletGeometry.rotateX(Math.PI / 2); // Pre-rotate so it aligns naturally with Z axis forwards

// Map Config
const MAP_SIZE = CONFIG.mapBounds;

const getGroundElevation = (px, pz) => {
  const dist = Math.sqrt(px * px + pz * pz);
  if (dist < 45) return 0; // Village is flat
  const blend = Math.max(0, Math.min(1, (dist - 45) / 15));
  let h = Math.sin(px * 0.04) * Math.cos(pz * 0.04) * 12;
  h += Math.sin(px * 0.1) * Math.cos(pz * 0.1) * 3;
  const edgeDist = Math.max(0, dist - 75);
  h += (edgeDist * 0.8);
  if (Math.abs(px) > 40 && Math.abs(pz) < 30) h -= 10; // Lakes East/West
  if (pz < -60 && Math.abs(px) < 15) h += 20; // North cliff
  return h * blend;
};

function startGameWorld() {
  switchScreen('hud');
  GameState.isActive = true;
  UI.hud.crosshair.style.display = 'block';

  if (!GameState.isHost && !GameState.localPlayer.name) {
    GameState.localPlayer.name = UI.menu.username.value.trim() || 'Guest';
    GameState.localPlayer.weapon = UI.menu.weaponSelect.value || 'rifle';
    GameState.localPlayer.ammo = WEAPONS[GameState.localPlayer.weapon].mag;
    GameState.localPlayer.color = CONFIG.playerColors[Math.floor(Math.random() * CONFIG.playerColors.length)];
  }

  // Host also needs to set their weapon
  if (GameState.isHost) {
    GameState.localPlayer.weapon = UI.menu.weaponSelect.value || 'rifle';
    GameState.localPlayer.ammo = WEAPONS[GameState.localPlayer.weapon].mag;
  }

  initThreeJS();
}

function initThreeJS() {
  // Renderer
  const canvas = document.getElementById('game-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Scene (Bright, vibrant, atmospheric)
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6dd5ed); // Bright sky blue
  scene.fog = new THREE.FogExp2(0x6dd5ed, 0.007);

  // Camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

  // Lighting (Brighter, warmer sunlight)
  const ambientLight = new THREE.AmbientLight(0xfffce0, 0.75); // soft warm
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(40, 80, 50);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  const d = 60;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.camera.far = 200;
  scene.add(dirLight);

  // Game specific variables point lights
  const colors = [0x00f0ff, 0xff0055, 0x33ff77];
  for (let i = 0; i < 4; i++) {
    const pLight = new THREE.PointLight(colors[i % colors.length], 2, 40);
    pLight.position.set(Math.random() * 40 - 20, 5, Math.random() * 40 - 20);
    scene.add(pLight);
  }

  buildMap();
  setupInputControls();

  // Initial Spawn
  respawnLocalPlayer();

  clock = new THREE.Clock();

  // Set up Network Tick (20Hz)
  setInterval(networkTick, CONFIG.syncRate);

  renderer.setAnimationLoop(gameLoop);
}

function buildMap() {
  // --- Materials (Vibrant & Low-Poly) ---
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x66cc66, roughness: 1.0, flatShading: true });
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xcdba96, roughness: 1.0, flatShading: true });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a929a, roughness: 0.9, flatShading: true });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9, flatShading: true });
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x4a2e15, roughness: 1.0, flatShading: true });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xfdf6e3, roughness: 0.9, flatShading: true });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xa9b0b3, roughness: 0.9, flatShading: true });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4ca64c, roughness: 0.9, flatShading: true });
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x87cefa, roughness: 0.2, metalness: 0.6, flatShading: true });

  // New Architecture Materials
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.8, flatShading: true });
  const glowWinMat = new THREE.MeshBasicMaterial({ color: 0xffffee });
  const redWoodMat = new THREE.MeshStandardMaterial({ color: 0x8b2500, roughness: 0.8, flatShading: true });
  const greenRoofMat = new THREE.MeshStandardMaterial({ color: 0x3d7a4d, roughness: 0.9, flatShading: true });
  const blueRoofMat = new THREE.MeshStandardMaterial({ color: 0x5dade2, roughness: 0.8, flatShading: true });
  const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.9, flatShading: true });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xfffcf0, roughness: 0.9, flatShading: true });
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 1.0, flatShading: true });

  const roofMats = [
    new THREE.MeshStandardMaterial({ color: 0xe74c3c, flatShading: true }), // Red
    new THREE.MeshStandardMaterial({ color: 0x3498db, flatShading: true }), // Blue
    new THREE.MeshStandardMaterial({ color: 0xdd8833, flatShading: true })  // Orange
  ];
  const awningMats = [
    [0xff3333, 0xffffff], // Red/White
    [0x3366ff, 0xffff66]  // Blue/Yellow
  ];

  // --- Water Material (Custom Shader for animation) ---
  const waterUniforms = {
    uTime: { value: 0 }
  };
  const waterMat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        // Simple scrolling noise/foam effect
        float basePattern = sin(vUv.x * 20.0 + uTime * 2.0) * cos(vUv.y * 20.0 + uTime * 3.0);
        vec3 deepColor = vec3(0.0, 0.5, 0.8);
        vec3 shallowColor = vec3(0.3, 0.8, 0.9);
        vec3 color = mix(deepColor, shallowColor, basePattern * 0.5 + 0.5);
        
        gl_FragColor = vec4(color, 0.85); // slight transparency
      }
    `,
    transparent: true,
    side: THREE.DoubleSide
  });
  waterMaterials.push(waterMat);

  // --- Ground & Plaza (Procedural Low-Poly Terrain) ---
  const gridRes = 80;
  let indexTerrainGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, gridRes, gridRes);
  const posIdx = indexTerrainGeo.attributes.position;
  for (let i = 0; i < posIdx.count; i++) {
    const px = posIdx.getX(i);
    const pz = -posIdx.getY(i);
    posIdx.setZ(i, getGroundElevation(px, pz));
  }

  // Convert to unindexed for distinct flat-shaded faces and colors
  const terrainGeo = indexTerrainGeo.toNonIndexed();
  terrainGeo.computeVertexNormals();

  const posNonIdx = terrainGeo.attributes.position;
  const colors = [];
  const cSand = new THREE.Color(0xd2b48c);
  const cGrass = new THREE.Color(0x66cc66);
  const cDarkGrass = new THREE.Color(0x4ca64c);
  const cRock = new THREE.Color(0x8a929a);
  const cSnow = new THREE.Color(0xffffff);

  for (let i = 0; i < posNonIdx.count; i += 3) {
    const h1 = posNonIdx.getZ(i);
    const h2 = posNonIdx.getZ(i + 1);
    const h3 = posNonIdx.getZ(i + 2);
    const avgH = (h1 + h2 + h3) / 3;

    let col = cGrass;
    if (avgH < -0.5) col = cSand;
    else if (avgH > 22) col = cSnow;
    else if (avgH > 15) col = cRock;
    else if (avgH > 6) col = cDarkGrass;

    colors.push(col.r, col.g, col.b);
    colors.push(col.r, col.g, col.b);
    colors.push(col.r, col.g, col.b);
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    flatShading: true
  });
  const ground = new THREE.Mesh(terrainGeo, terrainMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  ground.updateMatrixWorld(true); // CRITICAL: Update so Raycaster can find it immediately

  const createFlatPlane = (w, h, y) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), pathMat);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; mesh.receiveShadow = true;
    scene.add(mesh);
  };
  createFlatPlane(120, 12, 0.01); // East-West road
  createFlatPlane(12, 120, 0.02); // North-South road
  createFlatPlane(30, 30, 0.03); // Center plaza

  // --- Global Water & Waterfall ---
  const globalWaterGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 64, 64);
  const waterPos = globalWaterGeo.attributes.position;
  // Make the water surface slightly bumpy to break up z-fighting on shores
  for (let i = 0; i < waterPos.count; i++) {
    waterPos.setZ(i, (Math.random() - 0.5) * 0.4);
  }
  globalWaterGeo.computeVertexNormals();

  const globalWater = new THREE.Mesh(globalWaterGeo, waterMat);
  globalWater.rotation.x = -Math.PI / 2;
  globalWater.position.y = -0.5; // Raised slightly to create clear shorelines
  scene.add(globalWater);

  // Waterfall (Curved cascade flowing out of the mountain)
  const fallShape = new THREE.Shape();
  fallShape.moveTo(-10, 0);
  fallShape.lineTo(10, 0);

  const extrudeSettings = {
    steps: 12,
    depth: 35,
    bevelEnabled: false,
    extrudePath: new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 22, -85),
      new THREE.Vector3(0, 18, -80),
      new THREE.Vector3(0, 8, -70),
      new THREE.Vector3(0, -0.2, -60)
    ])
  };

  const fallGeo = new THREE.ExtrudeGeometry(fallShape, extrudeSettings);
  const fallPos = fallGeo.attributes.position;
  // Add mild turbulence to the waterfall surface
  for (let i = 0; i < fallPos.count; i++) {
    const x = fallPos.getX(i);
    const y = fallPos.getY(i);
    const z = fallPos.getZ(i);
    // Perturb mainly the forward facing normals
    fallPos.setXYZ(i, x + (Math.random() - 0.5) * 0.5, y + (Math.random() - 0.5) * 0.5, z);
  }
  fallGeo.computeVertexNormals();

  const waterfall = new THREE.Mesh(fallGeo, waterMat);
  scene.add(waterfall);

  // --- Procedural Makers ---
  const addPropCluster = (x, z) => {
    const num = Math.floor(Math.random() * 4) + 2;
    for (let i = 0; i < num; i++) {
      const px = x + (Math.random() - 0.5) * 4;
      const pz = z + (Math.random() - 0.5) * 4;

      const rc = new THREE.Raycaster(new THREE.Vector3(px, 100, pz), new THREE.Vector3(0, -1, 0));
      const hits = rc.intersectObject(ground);
      const ph = hits.length > 0 ? hits[0].point.y : getGroundElevation(px, pz);
      if (Math.random() > 0.4) {
        // Barrel
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.5, 8), darkWoodMat);
        m.position.set(px, ph + 0.75, pz); m.castShadow = true; m.receiveShadow = true; scene.add(m);
        const col = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.5, 1.2));
        col.position.set(px, ph + 0.75, pz); col.updateMatrixWorld();
        mapColliders.push(new THREE.Box3().setFromObject(col));
      } else {
        // Crate
        const s = 1 + Math.random();
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), woodMat);
        m.position.set(px, ph + s / 2, pz); m.rotation.y = Math.random() * Math.PI;
        m.castShadow = true; m.receiveShadow = true; scene.add(m);
        const col = new THREE.Mesh(new THREE.BoxGeometry(s, s, s));
        col.position.copy(m.position); col.rotation.copy(m.rotation); col.updateMatrixWorld();
        mapColliders.push(new THREE.Box3().setFromObject(col));
      }
    }
  };

  const createTree = (x, z) => {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObject(ground);
    const baseH = hits.length > 0 ? hits[0].point.y : getGroundElevation(x, z);
    const tGroup = new THREE.Group();
    tGroup.position.set(x, baseH, z);
    scene.add(tGroup);

    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 2, 5), darkWoodMat);
    trunk.position.y = 1; trunk.castShadow = true; tGroup.add(trunk);
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(2.5, 5, 6), leafMat);
    c1.position.y = 3.5; c1.castShadow = true; tGroup.add(c1);
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(1.8, 4, 6), leafMat);
    c2.position.y = 6; c2.castShadow = true; tGroup.add(c2);

    const col = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
    col.position.set(x, baseH + 1, z); col.updateMatrixWorld();
    mapColliders.push(new THREE.Box3().setFromObject(col));
  };

  const createStall = (x, z, rot, colorIdx) => {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObject(ground);
    const baseH = hits.length > 0 ? hits[0].point.y : getGroundElevation(x, z);

    const group = new THREE.Group();
    group.position.set(x, baseH, z);
    group.rotation.y = rot;
    scene.add(group);

    const table = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 2), woodMat);
    table.position.y = 1.2; table.castShadow = true; table.receiveShadow = true;
    group.add(table);

    // Collider for just the table
    const tableCol = new THREE.Mesh(table.geometry);
    tableCol.position.copy(table.position); tableCol.rotation.copy(table.rotation);
    tableCol.position.add(group.position); tableCol.rotation.y += group.rotation.y;
    tableCol.updateMatrixWorld();
    mapColliders.push(new THREE.Box3().setFromObject(tableCol));

    const pGeo = new THREE.BoxGeometry(0.2, 3.5, 0.2);
    [[-1.8, -0.8], [1.8, -0.8], [-1.8, 0.8], [1.8, 0.8]].forEach(pos => {
      const p = new THREE.Mesh(pGeo, woodMat); p.position.set(pos[0], 1.75, pos[1]);
      p.castShadow = true; group.add(p);

      // Separate collider for each thin post
      const pCol = new THREE.Mesh(pGeo);
      pCol.position.copy(p.position);
      pCol.position.add(group.position); pCol.rotation.y = group.rotation.y;
      pCol.updateMatrixWorld();
      mapColliders.push(new THREE.Box3().setFromObject(pCol));
    });

    // Striped Awning
    const c1 = new THREE.MeshStandardMaterial({ color: awningMats[colorIdx % 2][0], flatShading: true });
    const c2 = new THREE.MeshStandardMaterial({ color: awningMats[colorIdx % 2][1], flatShading: true });
    const w = 4.2 / 7;
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 3.2), (i % 2 === 0) ? c1 : c2);
      m.position.set(-2.1 + w / 2 + i * w, 3.6, 0); m.rotation.x = -Math.PI / 8;
      m.castShadow = true; group.add(m);
    }
  };

  const createHouse = (x, z, rot, styleIdx) => {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObject(ground);
    const baseH = hits.length > 0 ? hits[0].point.y : getGroundElevation(x, z);

    const group = new THREE.Group();
    group.position.set(x, baseH, z);
    group.rotation.y = rot;
    scene.add(group);

    // CRITICAL: We MUST update the world matrix of the group before adding colliders to it.
    // Otherwise their world matrices will evaluate relative to 0,0,0, trapping the player at spawn!
    group.updateMatrixWorld(true);

    const addCol = (cw, ch, cd, px, py, pz) => {
      const colObj = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, cd));
      colObj.position.set(px, py, pz);
      group.add(colObj);
      colObj.updateMatrixWorld(true);
      mapColliders.push(new THREE.Box3().setFromObject(colObj));
      group.remove(colObj); // Keep the physics box invisible
    };

    if (styleIdx === 0) {
      // 1. Apartment Building (Tall, balconies, glowing windows)
      const w = 6, d = 6, h = 18;
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plasterMat);
      base.position.y = h / 2;
      base.castShadow = true; base.receiveShadow = true;
      group.add(base);
      addCol(w, h, d, 0, h / 2, 0);

      // Roof details
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.4, d + 0.4), concreteMat);
      roof.position.y = h; roof.castShadow = true; group.add(roof);
      const penthouse = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), plasterMat);
      penthouse.position.set(0, h + 1, -1); penthouse.castShadow = true; group.add(penthouse);

      // Balconies on the front (z = d/2)
      for (let floors = 1; floors < 5; floors++) {
        const by = floors * 3.2;
        const balc = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1.5), concreteMat);
        balc.position.set(-0.5, by, d / 2 + 0.75);
        balc.castShadow = true;
        group.add(balc);

        // Glowing Windows
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 0.1), glowWinMat);
        win.position.set(1.5, by + 1.2, d / 2 + 0.05);
        group.add(win);
      }

      // Entrance
      const step = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 1.5), concreteMat);
      step.position.set(0, 0.25, d / 2 + 0.75);
      group.add(step);
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 0.1), darkWoodMat);
      door.position.set(0, 1.5, d / 2 + 0.05);
      group.add(door);
      addCol(3, 0.5, 1.5, 0, 0.25, d / 2 + 0.75);

      // Rooftop Access Stairs (Zig-zaging up the back using AABB-friendly steps)
      let curY = 0;
      for (let r = 0; r < 6; r++) {
        const flightH = 3;
        const numSteps = 8;
        const stepW = 5.0 / numSteps;
        const stepH = flightH / numSteps;

        const isRightZ = r % 2 === 0;
        const xStart = isRightZ ? -2.5 : 2.5;
        const xDir = isRightZ ? 1 : -1;
        const zPos = -d / 2 - 0.75; // Back of building

        for (let s = 0; s < numSteps; s++) {
          const stepGeo = new THREE.BoxGeometry(Math.abs(stepW), stepH, 1.5);
          const stepMesh = new THREE.Mesh(stepGeo, woodMat);

          // Position relative to start of flight
          stepMesh.position.set(xStart + xDir * (s * stepW + stepW / 2), curY + (s * stepH) + stepH / 2, zPos);
          stepMesh.castShadow = true;
          group.add(stepMesh);

          // Physics collider (No rotation = perfect AABB support)
          const colObj = new THREE.Mesh(stepGeo);
          colObj.position.copy(stepMesh.position);
          group.add(colObj);
          colObj.updateMatrixWorld(true);
          mapColliders.push(new THREE.Box3().setFromObject(colObj));
          group.remove(colObj);
        }
        curY += flightH;
      }

      // Top platform connecting ramp finish to roof
      const topPlat = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2.5), woodMat);
      topPlat.position.set(-2, h, -d / 2 - 0.75);
      group.add(topPlat);
      addCol(2, 0.2, 2.5, -2, h, -d / 2 - 0.75);

    } else if (styleIdx === 1) {
      // 2. Whimsical Raised Cabin
      const w = 5, d = 5, h = 4;
      const raisedY = 1.5;

      // Deck/Platform
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w + 2.5, 0.3, d + 3.5), woodMat);
      deck.position.set(0, raisedY, 0.5);
      deck.castShadow = true; deck.receiveShadow = true;
      group.add(deck);
      addCol(w + 2.5, raisedY + 0.3, d + 3.5, 0, raisedY / 2, 0.5); // block walking under it completely

      // Posts (Thicket of logs holding it)
      const pGeo = new THREE.CylinderGeometry(0.2, 0.2, raisedY, 8);
      [[-w / 2 - 1, -d / 2], [w / 2 + 1, -d / 2], [-w / 2 - 1, d / 2 + 1.5], [w / 2 + 1, d / 2 + 1.5], [0, 0], [-w / 2 + 1, 0]].forEach(pos => {
        const p = new THREE.Mesh(pGeo, darkWoodMat);
        p.position.set(pos[0], raisedY / 2, pos[1]); p.castShadow = true; group.add(p);
      });

      // Cabin Body with vertical wood planks (using darkWoodMat for edges to simulate planks)
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plasterMat);
      body.position.set(0, raisedY + h / 2 + 0.15, 0); body.castShadow = true; group.add(body);
      addCol(w, h, d, 0, raisedY + h / 2 + 0.15, 0);

      // Proper solid corner and edge trims (replacing the buggy wireframe trick)
      const tW = 0.2, tD = 0.2;
      [
        [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]
      ].forEach(pos => {
        const t = new THREE.Mesh(new THREE.BoxGeometry(tW, h + 0.1, tD), woodMat);
        t.position.set(pos[0], raisedY + h / 2 + 0.15, pos[1]); group.add(t);
      });
      // Bottom/Top trims
      const bTrim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.2, d + 0.2), woodMat);
      bTrim.position.set(0, raisedY + 0.25, 0); group.add(bTrim);
      const tTrim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.2, d + 0.2), woodMat);
      tTrim.position.set(0, raisedY + h + 0.05, 0); group.add(tTrim);

      // Oversized Blue Roof setup
      const rGeo = new THREE.ConeGeometry(4.8, 4.5, 4);
      const roof = new THREE.Mesh(rGeo, blueRoofMat);
      roof.position.set(0, raisedY + h + 2.25, 0);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true; group.add(roof);

      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.8, 3, 0.8), concreteMat);
      chimney.position.set(-1.5, raisedY + h + 1.5, -1); group.add(chimney);

      // Deck railings
      const railGeo = new THREE.BoxGeometry(w + 2.5, 0.8, 0.1);
      const railR = new THREE.Mesh(railGeo, woodMat); railR.position.set(0, raisedY + 0.6, -d / 2 - 1.2); group.add(railR);
      const railSide1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, d + 3.5), woodMat);
      railSide1.position.set(-w / 2 - 1.2, raisedY + 0.6, 0.5); group.add(railSide1);
      const railSide2 = railSide1.clone(); railSide2.position.set(w / 2 + 1.2, raisedY + 0.6, 0.5); group.add(railSide2);

      // Stairs
      const stairs = new THREE.Mesh(new THREE.BoxGeometry(2, raisedY + 0.5, 2.5), woodMat);
      stairs.position.set(0, raisedY / 2, d / 2 + 3);
      stairs.rotation.x = -Math.PI / 4; // ramp-like
      stairs.castShadow = true; group.add(stairs);
      addCol(2, raisedY, 2.5, 0, raisedY / 2, d / 2 + 3.5);

      // Door & Round Window
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.1), woodMat);
      door.position.set(0, raisedY + 1.15, d / 2 + 0.05); group.add(door);

      const win = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.1, 8), windowMat);
      win.rotation.x = Math.PI / 2;
      win.position.set(1.5, raisedY + 2, d / 2 + 0.05); group.add(win);

      const winCross = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.12), woodMat);
      winCross.position.copy(win.position); group.add(winCross);
      const winCross2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.12), woodMat);
      winCross2.position.copy(win.position); group.add(winCross2);

    } else if (styleIdx === 2) {
      // 3. Asian Shop/Tavern
      const w = 7, d = 5, h = 6;

      // Main Body
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), whiteMat);
      base.position.set(0, h / 2, 0); base.castShadow = true; base.receiveShadow = true;
      group.add(base);
      addCol(w, h, d, 0, h / 2, 0);

      // Red framework beams (mid floor trim)
      const bGeo = new THREE.BoxGeometry(w + 0.4, 0.4, d + 0.4);
      const mFloor = new THREE.Mesh(bGeo, redWoodMat);
      mFloor.position.set(0, h / 2 + 0.5, 0); group.add(mFloor);

      // Green curved roofs
      const rShape = new THREE.Shape();
      rShape.moveTo(-w / 2 - 1, 0);
      rShape.quadraticCurveTo(0, 1.5, w / 2 + 1, 0);
      rShape.lineTo(w / 2 + 1.5, 2.5);
      rShape.lineTo(-w / 2 - 1.5, 2.5);

      const exSet = { depth: d + 2, bevelEnabled: false };
      const roofGeo = new THREE.ExtrudeGeometry(rShape, exSet);
      roofGeo.translate(0, 0, -(d + 2) / 2);
      const mainRoof = new THREE.Mesh(roofGeo, greenRoofMat);
      mainRoof.position.set(0, h + 1.25, 0); mainRoof.castShadow = true; group.add(mainRoof);

      // First floor overhang roof
      const overhang = new THREE.Mesh(roofGeo, greenRoofMat);
      overhang.scale.set(1.1, 0.6, 1.1);
      overhang.position.set(0, h / 2 - 0.5, 0); overhang.castShadow = true; group.add(overhang);

      // Open shop front
      const shopHole = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 0.2), darkWoodMat);
      shopHole.position.set(0, 1.25, d / 2 + 0.05); group.add(shopHole);
      const counter = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1), woodMat);
      counter.position.set(0, 0.5, d / 2 + 0.5); counter.castShadow = true; group.add(counter);
      addCol(4, 1, 1, 0, 0.5, d / 2 + 0.5);

      // Lanterns
      const lGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 6);
      const lMat = new THREE.MeshBasicMaterial({ color: 0xff4422 });
      const l1 = new THREE.Mesh(lGeo, lMat); l1.position.set(-2.8, 2, d / 2 + 1.2); group.add(l1);
      const l2 = new THREE.Mesh(lGeo, lMat); l2.position.set(2.8, 2, d / 2 + 1.2); group.add(l2);

      // Backstairs to Overhang Roof for climbing strategy
      const numSteps = 7;
      const stepD = 3.5 / numSteps;
      const stepH = 2.5 / numSteps;
      for (let s = 0; s < numSteps; s++) {
        const stepGeo = new THREE.BoxGeometry(2, stepH, stepD);
        const bStair = new THREE.Mesh(stepGeo, woodMat);

        // Stagger them downwards and outwards
        bStair.position.set(0, s * stepH + stepH / 2, -d / 2 - 0.5 - (numSteps - 1 - s) * stepD - stepD / 2);
        bStair.castShadow = true;
        group.add(bStair);

        // Stair collider
        const colObj = new THREE.Mesh(stepGeo);
        colObj.position.copy(bStair.position);
        group.add(colObj);
        colObj.updateMatrixWorld(true);
        mapColliders.push(new THREE.Box3().setFromObject(colObj));
        group.remove(colObj);
      }

      // Upper connecting platform dropping onto the green roof
      const uPlat = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), woodMat);
      uPlat.position.set(0, 2.5, -d / 2 - 0.5);
      group.add(uPlat);
      addCol(2, 0.2, 2, 0, 2.5, -d / 2 - 0.5);

    } else {
      // 4. Suburban Home
      const w = 7, d = 6, h = 3.5;

      // Main home
      const main = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), whiteMat);
      main.position.set(-1.5, h / 2, 0); main.castShadow = true; main.receiveShadow = true;
      group.add(main);
      addCol(w, h, d, -1.5, h / 2, 0);

      // Garage (attached)
      const gW = 5, gD = 6;
      const garage = new THREE.Mesh(new THREE.BoxGeometry(gW, h - 0.5, gD), whiteMat);
      garage.position.set(4.5, (h - 0.5) / 2, 0); garage.castShadow = true; group.add(garage);
      addCol(gW, h - 0.5, gD, 4.5, (h - 0.5) / 2, 0);

      const gDoor = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 0.1), concreteMat);
      gDoor.position.set(4.5, 1.2, gD / 2 + 0.05); group.add(gDoor);

      // Pitched roofs
      const rH = 3;
      const rShape = new THREE.Shape();
      rShape.moveTo(-w / 2 - 0.5, 0); rShape.lineTo(w / 2 + 0.5, 0); rShape.lineTo(0, rH);
      const rmGeo = new THREE.ExtrudeGeometry(rShape, { depth: d + 1, bevelEnabled: false });
      rmGeo.translate(0, 0, -(d + 1) / 2);
      const mainRoof = new THREE.Mesh(rmGeo, asphaltMat);
      mainRoof.position.set(-1.5, h, 0); mainRoof.castShadow = true; group.add(mainRoof);

      const gShape = new THREE.Shape();
      gShape.moveTo(-gW / 2 - 0.5, 0); gShape.lineTo(gW / 2 + 0.5, 0); gShape.lineTo(0, rH * 0.8);
      const rgGeo = new THREE.ExtrudeGeometry(gShape, { depth: gD + 1, bevelEnabled: false });
      rgGeo.translate(0, 0, -(gD + 1) / 2);
      const gRoof = new THREE.Mesh(rgGeo, asphaltMat);
      gRoof.position.set(4.5, h - 0.5, 0); gRoof.castShadow = true; group.add(gRoof);

      // Yard Fence
      const fGeo = new THREE.BoxGeometry(w, 1.2, 0.1);
      const f1 = new THREE.Mesh(fGeo, fenceMat); f1.position.set(-1.5, 0.6, d / 2 + 4); group.add(f1);
      const fGeoSide = new THREE.BoxGeometry(0.1, 1.2, 4);
      const f2 = new THREE.Mesh(fGeoSide, fenceMat); f2.position.set(-1.5 - w / 2, 0.6, d / 2 + 2); group.add(f2);
      const f3 = new THREE.Mesh(fGeoSide, fenceMat); f3.position.set(-1.5 + w / 2, 0.6, d / 2 + 2); group.add(f3);

      // Driveway
      const drive = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.1, 5), concreteMat);
      drive.position.set(4.5, 0.05, gD / 2 + 2.5); group.add(drive);

      // Windows / Door
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.2), darkWoodMat);
      door.position.set(0.5, 1.1, d / 2 + 0.05); group.add(door);
      const win = new THREE.Mesh(new THREE.BoxGeometry(2, 1.5, 0.2), windowMat);
      win.position.set(-3, 1.8, d / 2 + 0.05); group.add(win);

      // Window panes
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 0.22), whiteMat);
      pane.position.copy(win.position); group.add(pane);
      const pane2 = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.22), whiteMat);
      pane2.position.copy(win.position); group.add(pane2);

      // Chimney
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), redWoodMat); // using red wood to simulate brick color
      chimney.position.set(w / 2 - 1, h + 1, -1); group.add(chimney);
      // Small smoke stack
      const smokeStack = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 4), concreteMat);
      smokeStack.position.set(w / 2 - 1, h + 3.2, -1); group.add(smokeStack);

      // Front yard bush
      const bushMat = new THREE.MeshStandardMaterial({ color: 0x4ca64c, roughness: 1.0, flatShading: true });
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), bushMat);
      bush.position.set(-3, 1.0, d / 2 + 2); group.add(bush);

      // Crates to allow climbing the garage roof
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), woodMat);
      c1.position.set(gW + 1.5, 0.75, gD / 2 + 0.5); group.add(c1);
      addCol(1.5, 1.5, 1.5, gW + 1.5, 0.75, gD / 2 + 0.5);

      const c2 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), woodMat);
      c2.position.set(gW + 1.0, 2.0, gD / 2 - 0.5); group.add(c2);
      addCol(1.5, 1.5, 1.5, gW + 1.0, 2.0, gD / 2 - 0.5);

    }
  };

  // --- Layout Village (Organic Scatter) ---

  // Randomize center stalls slightly, snapping rotations to 90 degrees for AABB collision
  const randRot = () => Math.floor(Math.random() * 4) * (Math.PI / 2);
  createStall(5 + Math.random() * 2, 5 + Math.random() * 2, randRot(), 0);
  createStall(-5 - Math.random() * 2, 5 + Math.random() * 2, randRot(), 1);
  createStall(5 + Math.random() * 2, -5 - Math.random() * 2, randRot(), 1);
  createStall(-5 - Math.random() * 2, -5 - Math.random() * 2, randRot(), 0);

  // Scatter Houses organically around the center plaza
  const housesToPlace = 16;
  let placedHouses = 0;
  let attempts = 0;
  const housePositions = [];

  while (placedHouses < housesToPlace && attempts < 100) {
    attempts++;
    const angle = Math.random() * Math.PI * 2;
    const dist = 14 + Math.random() * 24; // Between 14 and 38 units away
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;

    // Ensure we don't spawn directly on the main cross paths
    if (Math.abs(x) < 5 || Math.abs(z) < 5) continue;

    // Check distance against other houses to prevent ugly overlap
    let tooClose = false;
    for (let pos of housePositions) {
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (Math.sqrt(dx * dx + dz * dz) < 14) { // Increased minimum distance between houses
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    housePositions.push({ x, z });

    // Rotate the house to roughly face the center plaza, snapped to 90deg for AABB physics
    const baseRot = Math.atan2(x, z) + Math.PI;
    const rot = Math.round(baseRot / (Math.PI / 2)) * (Math.PI / 2);

    const styleIdx = Math.floor(Math.random() * 4); // Pick one of 4 rich styles

    createHouse(x, z, rot, styleIdx);
    placedHouses++;
  }

  // Props scattered far out
  for (let i = 0; i < 30; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 25 + Math.random() * ((MAP_SIZE / 2) - 30);
    addPropCluster(Math.cos(angle) * r, Math.sin(angle) * r);
  }

  // Trees (More trees pushed outwards)
  for (let i = 0; i < 80; i++) {
    const x = (Math.random() - 0.5) * MAP_SIZE * 0.9;
    const z = (Math.random() - 0.5) * MAP_SIZE * 0.9;
    if (Math.abs(x) > 20 || Math.abs(z) > 20) {
      createTree(x, z);
    }
  }

  // Hand-picked spawn points guaranteed to be safely in the center plaza
  spawnPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(2, 0, 2),
    new THREE.Vector3(-2, 0, -2),
    new THREE.Vector3(2, 0, -2),
    new THREE.Vector3(-2, 0, 2)
  ];
}

function createPlayerMesh(colorHex) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.4 });
  const body = new THREE.Mesh(bodyGeometry, bodyMat);
  body.position.y = 0.75;
  body.castShadow = true;
  group.add(body);

  const headMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3 });
  const head = new THREE.Mesh(headGeometry, headMat);
  head.position.y = 1.75;
  head.castShadow = true;
  group.add(head);

  // Gun proxy
  const gunGeo = new THREE.BoxGeometry(0.2, 0.2, 0.8);
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const gun = new THREE.Mesh(gunGeo, gunMat);
  gun.position.set(0.4, 1.2, 0.3);
  group.add(gun);

  scene.add(group);
  return group;
}

let viewWeaponGroup;
let recoilTime = 0;
let flashTime = 0;

function createLocalWeaponView() {
  if (viewWeaponGroup) {
    camera.remove(viewWeaponGroup);
  }

  viewWeaponGroup = new THREE.Group();

  const wKey = GameState.localPlayer.weapon || 'rifle';

  const mDark = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.2 });
  const mGrey = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.6, roughness: 0.4 });
  const mWood = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 });
  const mSight = new THREE.MeshStandardMaterial({ color: 0xff0055, emissive: 0x440011 });

  let barrelTipZ = -0.92;

  if (wKey === 'shotgun') {
    // Heavy Shotgun (Grey barrel, wooden pump and stock)
    const bodyGeo = new THREE.BoxGeometry(0.12, 0.2, 0.6);
    const body = new THREE.Mesh(bodyGeo, mGrey);
    body.position.set(0, 0, -0.1);

    const barrelGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8);
    const barrel = new THREE.Mesh(barrelGeo, mGrey);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05, -0.6);

    // Below barrel tube
    const tubeGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8);
    const tube = new THREE.Mesh(tubeGeo, mGrey);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, -0.02, -0.5);

    const pumpGeo = new THREE.BoxGeometry(0.14, 0.08, 0.3);
    const pump = new THREE.Mesh(pumpGeo, mWood);
    pump.position.set(0, -0.04, -0.5);

    const stockGeo = new THREE.BoxGeometry(0.1, 0.25, 0.4);
    const stock = new THREE.Mesh(stockGeo, mWood);
    stock.position.set(0, -0.08, 0.3);
    stock.rotation.x = -0.1;

    viewWeaponGroup.add(body, barrel, tube, pump, stock);
    barrelTipZ = -1.0;

  } else if (wKey === 'sniper') {
    // Wooden Sniper with Black Barrel and Large Scope

    // Wooden Body/Stock
    const bodyGeo = new THREE.BoxGeometry(0.08, 0.15, 0.9);
    const body = new THREE.Mesh(bodyGeo, mWood);
    body.position.set(0, 0, -0.1);

    // Angled Stock end
    const stockGeo = new THREE.BoxGeometry(0.08, 0.22, 0.3);
    const stock = new THREE.Mesh(stockGeo, mWood);
    stock.position.set(0, -0.05, 0.45);
    stock.rotation.x = -0.15;

    // Thin Black Barrel
    const barrelGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8);
    const barrel = new THREE.Mesh(barrelGeo, mDark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.06, -0.9);

    // Bolt mechanism
    const boltGeo = new THREE.BoxGeometry(0.06, 0.06, 0.2);
    const bolt = new THREE.Mesh(boltGeo, mDark);
    bolt.position.set(0.05, 0.06, -0.1);

    // Scope Mount
    const mountGeo = new THREE.BoxGeometry(0.04, 0.05, 0.15);
    const mount = new THREE.Mesh(mountGeo, mDark);
    mount.position.set(0, 0.1, -0.3);

    // Large Scope Tube
    const scopeGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.4, 12);
    const scope = new THREE.Mesh(scopeGeo, mDark);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.15, -0.3);

    // Scope Front Bell (Larger)
    const bellGeo = new THREE.CylinderGeometry(0.06, 0.04, 0.15, 12);
    const bell = new THREE.Mesh(bellGeo, mDark);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(0, 0.15, -0.55);

    // Scope Rear Eyepiece
    const eyeGeo = new THREE.CylinderGeometry(0.05, 0.04, 0.1, 12);
    const eye = new THREE.Mesh(eyeGeo, mDark);
    eye.rotation.x = Math.PI / 2;
    eye.position.set(0, 0.15, -0.05);

    // Glass lens for scope
    const lensGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12);
    const lens = new THREE.Mesh(lensGeo, new THREE.MeshStandardMaterial({ color: 0x112233, metalness: 1.0, roughness: 0 }));
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.15, -0.63); // Front lens

    viewWeaponGroup.add(body, stock, barrel, bolt, mount, scope, bell, eye, lens);
    barrelTipZ = -1.6;

  } else if (wKey === 'pistol') {
    // Silver Revolver with Wooden Grip

    // Main Silver Frame
    const frameGeo = new THREE.BoxGeometry(0.08, 0.15, 0.2);
    const frame = new THREE.Mesh(frameGeo, mGrey);
    frame.position.set(0, 0.05, -0.1);

    // Silver Octagonal Barrel
    const barrelGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.4, 8);
    const barrel = new THREE.Mesh(barrelGeo, mGrey);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.08, -0.4);

    // Revolver Cylinder (Drum)
    const drumGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 12);
    const drum = new THREE.Mesh(drumGeo, mDark);
    drum.rotation.x = Math.PI / 2;
    drum.position.set(0, 0.05, -0.12);

    // Dark Angled Wooden Grip
    const gripGeo = new THREE.BoxGeometry(0.07, 0.25, 0.12);
    const grip = new THREE.Mesh(gripGeo, mWood);
    grip.position.set(0, -0.1, 0.05);
    grip.rotation.x = -0.3; // Angle the grip back

    // Front Sight
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.02), mSight);
    sight.position.set(0, 0.12, -0.55);

    // Rear Sight
    const rsight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02), mDark);
    rsight.position.set(0, 0.12, 0);

    viewWeaponGroup.add(frame, barrel, drum, grip, sight, rsight);
    barrelTipZ = -0.6;

  } else {
    // Default Assault Rifle
    const bodyGeo = new THREE.BoxGeometry(0.15, 0.2, 0.8);
    const body = new THREE.Mesh(bodyGeo, mDark);
    body.position.set(0, 0, -0.2);

    const barrelGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8);
    const barrel = new THREE.Mesh(barrelGeo, mDark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05, -0.7);

    const sightGeo = new THREE.BoxGeometry(0.05, 0.08, 0.15);
    const sight = new THREE.Mesh(sightGeo, mSight);
    sight.position.set(0, 0.14, 0);

    viewWeaponGroup.add(body, barrel, sight);
    barrelTipZ = -0.92;
  }

  // Muzzle Flash Effect (hidden by default)
  const flashGroup = new THREE.Group();
  let flashLightColor = 0xffaa00;
  let flashIntensity = 2;

  const mFlashBase = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const mFlashCore = new THREE.MeshBasicMaterial({ color: 0xffffee, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });

  if (wKey === 'sniper') {
    // Huge, bright star-shaped flash
    const geoBase = new THREE.ConeGeometry(0.3, 0.8, 5);
    const m1 = new THREE.Mesh(geoBase, mFlashBase); m1.rotation.x = Math.PI / 2;
    const m2 = new THREE.Mesh(new THREE.ConeGeometry(0.15, 1.2, 4), mFlashCore); m2.rotation.x = Math.PI / 2;
    flashGroup.add(m1, m2);
    flashLightColor = 0xffeebb;
    flashIntensity = 5;
  } else if (wKey === 'shotgun') {
    // Wide, expanding scattered flash (Reduced size so it doesn't blind the player)
    const geoBase = new THREE.CylinderGeometry(0.2, 0.05, 0.3, 8);
    const m1 = new THREE.Mesh(geoBase, mFlashBase); m1.rotation.x = Math.PI / 2;
    const m2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mFlashCore);
    flashGroup.add(m1, m2);
    flashIntensity = 3;
  } else if (wKey === 'pistol') {
    // Small, tight flash
    const m1 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mFlashBase);
    flashGroup.add(m1);
    flashIntensity = 1.5;
  } else {
    // Assault Rifle
    const m1 = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 4), mFlashBase); m1.rotation.x = Math.PI / 2;
    const m2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mFlashCore);
    flashGroup.add(m1, m2);
  }

  // Add a real light so the gunshot lights up walls and the floor
  const flashLight = new THREE.PointLight(flashLightColor, flashIntensity, 10);

  flashGroup.add(flashLight);
  flashGroup.position.set(0, 0.05, barrelTipZ); // Tip of the dynamic barrel
  flashGroup.visible = false;

  viewWeaponGroup.muzzleFlash = flashGroup;
  viewWeaponGroup.muzzleLight = flashLight;

  viewWeaponGroup.add(flashGroup);

  // Offset weapon to bottom right of screen
  viewWeaponGroup.position.set(0.35, -0.3, -0.5);

  // Add to camera so it moves exactly with FPS view
  camera.add(viewWeaponGroup);
  scene.add(camera); // Must add camera to scene if it has children
}

function respawnLocalPlayer() {
  createLocalWeaponView(); // Ensure weapon exists

  const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
  camera.position.set(sp.x, 1.6, sp.z);

  // Reset Y rotation arbitrarily
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  euler.setFromQuaternion(camera.quaternion);
  euler.x = 0;
  euler.y = Math.random() * Math.PI * 2;
  camera.quaternion.setFromEuler(euler);

  GameState.localPlayer.health = CONFIG.maxHealth;
  GameState.localPlayer.ammo = WEAPONS[GameState.localPlayer.weapon || 'rifle'].mag;
  GameState.localPlayer.isDead = false;
  GameState.localPlayer.velocity.set(0, 0, 0);

  updateHUD();

  UI.hud.deathOverlay.classList.remove('show');
  UI.clickToLock.style.display = 'flex';
}

function dieAndRespawn(killerId, killerName) {
  GameState.localPlayer.isDead = true;
  GameState.localPlayer.health = 0;
  GameState.localPlayer.deaths++;
  document.exitPointerLock();

  UI.hud.deathOverlay.classList.add('show');
  UI.hud.killerName.innerText = killerName || 'Unknown';

  let countdown = 3;
  UI.hud.respawnTimer.innerText = `Respawning in ${countdown}...`;

  const intv = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      UI.hud.respawnTimer.innerText = `Respawning in ${countdown}...`;
    } else {
      clearInterval(intv);
      respawnLocalPlayer();
    }
  }, 1000);

  updateHUD();
}

/**
 * INPUT & CONTROLS
 */
// Euler for mouse look
const cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let isPointerLocked = false;
let isAiming = false;

function setupInputControls() {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW') GameState.input.forward = true;
    if (e.code === 'KeyS') GameState.input.backward = true;
    if (e.code === 'KeyA') GameState.input.left = true;
    if (e.code === 'KeyD') GameState.input.right = true;
    if (e.code === 'Space') GameState.input.space = true;
    if (e.code === 'ShiftLeft') GameState.input.shift = true;

    // Reload Ammo
    const maxAmmo = WEAPONS[GameState.localPlayer.weapon || 'rifle'].mag;
    if (e.code === 'KeyR' && GameState.localPlayer.ammo < maxAmmo) {
      GameState.localPlayer.ammo = maxAmmo;
      playSound('reload'); // Using existing hitsound temporarily if no reload sound
      updateHUD();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') GameState.input.forward = false;
    if (e.code === 'KeyS') GameState.input.backward = false;
    if (e.code === 'KeyA') GameState.input.left = false;
    if (e.code === 'KeyD') GameState.input.right = false;
    if (e.code === 'Space') GameState.input.space = false;
    if (e.code === 'ShiftLeft') GameState.input.shift = false;
  });

  UI.clickToLock.addEventListener('click', () => {
    document.body.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === document.body);
    if (isPointerLocked) {
      UI.clickToLock.style.display = 'none';
      UI.hud.crosshair.style.display = 'block';
    } else {
      if (!GameState.localPlayer.isDead && GameState.isActive) {
        UI.clickToLock.style.display = 'flex';
      }
      UI.hud.crosshair.style.display = 'none';
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPointerLocked || GameState.localPlayer.isDead) return;

    const sensitivity = 0.002;
    cameraEuler.setFromQuaternion(camera.quaternion);

    cameraEuler.y -= e.movementX * sensitivity;
    cameraEuler.x -= e.movementY * sensitivity;
    cameraEuler.x = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cameraEuler.x));

    camera.quaternion.setFromEuler(cameraEuler);
  });

  document.addEventListener('mousedown', (e) => {
    if (isPointerLocked && !GameState.localPlayer.isDead) {
      if (e.button === 0) {
        shootWeapon();
      } else if (e.button === 2 && GameState.localPlayer.weapon === 'sniper') {
        isAiming = true;
        if (UI.hud.scopeOverlay) UI.hud.scopeOverlay.style.display = 'block';
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 2) {
      isAiming = false;
      if (UI.hud.scopeOverlay) UI.hud.scopeOverlay.style.display = 'none';
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/**
 * GAME LOOP
 */
const playerAABB = new THREE.Box3();
const playerSize = new THREE.Vector3(0.5, 1.8, 0.5); // Narrowed physical width to fit through gaps

function updateLocalPhysics(dt) {
  if (GameState.localPlayer.isDead) {
    if (viewWeaponGroup) viewWeaponGroup.visible = false;
    return;
  }

  // Scoping Logic (Sniper Only)
  if (isAiming) {
    camera.fov = THREE.MathUtils.lerp(camera.fov, 20, dt * 10);
    if (viewWeaponGroup) viewWeaponGroup.visible = false; // Hide gun when aiming
  } else {
    camera.fov = THREE.MathUtils.lerp(camera.fov, 75, dt * 10);
    if (viewWeaponGroup) viewWeaponGroup.visible = true;
  }
  camera.updateProjectionMatrix();

  // Handle Recoil Animation & Flash
  if (recoilTime > 0) {
    recoilTime -= dt * 10;
    // move back and rotate up slightly based on time
    const amt = Math.max(0, recoilTime);
    viewWeaponGroup.position.z = -0.5 + (amt * 0.4); // More aggressive kickback
    viewWeaponGroup.rotation.x = amt * 0.5; // More visible barrel flip
  } else {
    viewWeaponGroup.position.z = -0.5;
    viewWeaponGroup.rotation.x = 0;
  }

  // Muzzle flash visibility logic
  if (flashTime > 0) {
    flashTime -= dt;
    if (viewWeaponGroup.muzzleFlash) {
      viewWeaponGroup.muzzleFlash.visible = true;
      viewWeaponGroup.muzzleFlash.rotation.z = Math.random() * Math.PI; // Flash variation
      viewWeaponGroup.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.5);
      if (viewWeaponGroup.muzzleLight) {
        viewWeaponGroup.muzzleLight.intensity = (Math.random() * 2 + 3); // Bright flash
      }
    }
  } else {
    if (viewWeaponGroup.muzzleFlash) viewWeaponGroup.muzzleFlash.visible = false;
  }

  const vel = GameState.localPlayer.velocity;

  const isUnderwater = camera.position.y < -0.5;

  // Apply gravity / buoyancy
  if (!GameState.localPlayer.onGround) {
    if (isUnderwater) {
      vel.y -= (CONFIG.gravity * 0.2) * dt; // Slower sinking in water
    } else {
      vel.y -= CONFIG.gravity * dt;
    }
  }

  // Keyboard Movement
  const moveDir = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0; forward.normalize();

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  right.y = 0; right.normalize();

  if (GameState.input.forward) moveDir.add(forward);
  if (GameState.input.backward) moveDir.sub(forward);
  if (GameState.input.right) moveDir.add(right);
  if (GameState.input.left) moveDir.sub(right);

  if (moveDir.lengthSq() > 0) moveDir.normalize();

  // Friction and acceleration
  // Friction and acceleration
  let isSliding = GameState.input.shift && GameState.localPlayer.onGround && !isUnderwater;
  let currentSpeed = isSliding ? CONFIG.playerSpeed * 1.25 : CONFIG.playerSpeed;

  // Severe movement penalty while aiming down sniper scope
  if (isAiming) {
    currentSpeed *= 0.15;
  }

  if (isUnderwater) {
    currentSpeed *= 0.4; // 60% slower in water
    scene.fog.color.setHex(0x226699);
    scene.fog.density = 0.08; // Thick blue fog
  } else {
    scene.fog.color.setHex(0x6dd5ed);
    scene.fog.density = 0.007; // Normal fog
  }

  const targetCamY = isSliding ? 0.8 : 1.6;

  vel.x = THREE.MathUtils.lerp(vel.x, moveDir.x * currentSpeed, 15 * dt);
  vel.z = THREE.MathUtils.lerp(vel.z, moveDir.z * currentSpeed, 15 * dt);

  // Jump (disable jumping while sliding)
  if (GameState.input.space && !isSliding) {
    if (isUnderwater) {
      // Swim upwards
      vel.y = THREE.MathUtils.lerp(vel.y, CONFIG.playerSpeed * 0.8, 4 * dt);
      GameState.localPlayer.onGround = false;
    } else if (GameState.localPlayer.onGround) {
      vel.y = CONFIG.playerJumpForce;
      GameState.localPlayer.onGround = false;
      playSound('jump');
    }
  }

  // Apply velocity to position
  const oldPos = camera.position.clone();
  const nextPos = oldPos.clone().addScaledVector(vel, dt);

  const getAABBCenter = (p) => new THREE.Vector3(p.x, p.y - targetCamY + (playerSize.y / 2), p.z);

  // Simple AABB Collision mapping
  playerAABB.setFromCenterAndSize(getAABBCenter(nextPos), playerSize);

  let collided = false;
  for (let obs of mapColliders) {
    if (playerAABB.intersectsBox(obs)) {
      collided = true;
      break;
    }
  }

  if (collided) {
    // ---- STEP-UP / STAIR MECHANIC ----
    // If we hit something, check if we can just step up onto it (e.g., stairs, ramp edges, curbs)
    const maxStepHeight = 0.75;
    const stepUpPos = nextPos.clone();
    stepUpPos.y += maxStepHeight;

    playerAABB.setFromCenterAndSize(getAABBCenter(stepUpPos), playerSize);
    let stepCollided = false;
    for (let obs of mapColliders) {
      if (playerAABB.intersectsBox(obs)) {
        stepCollided = true;
        break;
      }
    }

    if (!stepCollided && GameState.localPlayer.onGround) {
      // We can step up! Apply the movement but lift the player.
      // (The ground-snap logic below will pull them back down perfectly onto the ramp surface)
      nextPos.y += maxStepHeight;
    } else {
      // Try X only
      const nextPosX = oldPos.clone();
      nextPosX.x += vel.x * dt;
      playerAABB.setFromCenterAndSize(getAABBCenter(nextPosX), playerSize);
      let colX = false;
      for (let obs of mapColliders) if (playerAABB.intersectsBox(obs)) colX = true;

      // Try Z only
      const nextPosZ = oldPos.clone();
      nextPosZ.z += vel.z * dt;
      playerAABB.setFromCenterAndSize(getAABBCenter(nextPosZ), playerSize);
      let colZ = false;
      for (let obs of mapColliders) if (playerAABB.intersectsBox(obs)) colZ = true;

      if (!colX) nextPos.z = oldPos.z;
      else if (!colZ) nextPos.x = oldPos.x;
      else { nextPos.x = oldPos.x; nextPos.z = oldPos.z; }

      vel.x = 0; vel.z = 0;
    }
  }

  // Ground collision (Fix floating bug and handle crouching)
  let onGroundThisFrame = false;

  const groundH = getGroundElevation(nextPos.x, nextPos.z);

  // Slide mechanic: if player is too high up the boundary mountain, push them back down
  if (groundH > 18 && GameState.localPlayer.onGround) {
    const outwardDir = new THREE.Vector3(-nextPos.x, 0, -nextPos.z).normalize();
    vel.x += outwardDir.x * 25 * dt;
    vel.z += outwardDir.z * 25 * dt;
  }

  // Snap to ground if below it, or if walking down a slope within a 1 unit threshold
  if (nextPos.y <= groundH + targetCamY || (GameState.localPlayer.onGround && vel.y <= 0 && nextPos.y - (groundH + targetCamY) < 1.0)) {
    nextPos.y = groundH + targetCamY;
    if (vel.y < 0) vel.y = 0;
    onGroundThisFrame = true;
  } else {
    // Also check tops of boxes
    playerAABB.setFromCenterAndSize(getAABBCenter(nextPos), playerSize);
    for (let obs of mapColliders) {
      if (playerAABB.intersectsBox(obs)) {
        if (vel.y <= 0 && (oldPos.y - targetCamY) >= obs.max.y - 0.2) {
          nextPos.y = obs.max.y + targetCamY;
          vel.y = 0;
          onGroundThisFrame = true;
          break; // found ground, stop checking
        } else if (vel.y > 0) {
          nextPos.y = obs.min.y - 0.2; // hit head on underside
          vel.y = 0;
        }
      }
    }
  }

  // Smoothly lerp camera height for slide transition if we didn't just snap to a surface
  if (onGroundThisFrame) {
    nextPos.y = THREE.MathUtils.lerp(camera.position.y, nextPos.y, 15 * dt);
  }

  GameState.localPlayer.onGround = onGroundThisFrame;

  // Bounds checks
  const lim = MAP_SIZE / 2 - 1.5;
  nextPos.x = Math.max(-lim, Math.min(lim, nextPos.x));
  nextPos.z = Math.max(-lim, Math.min(lim, nextPos.z));

  camera.position.copy(nextPos);
}

function updateRemotePlayers(dt) {
  Object.keys(GameState.remotePlayers).forEach(id => {
    const rp = GameState.remotePlayers[id];

    if (rp.health <= 0) {
      if (rp.mesh) rp.mesh.visible = false;
      return;
    }

    if (!rp.mesh) {
      rp.mesh = createPlayerMesh(rp.color);
    }
    rp.mesh.visible = true;

    // Linear Interpolation
    if (rp.targetPos) {
      rp.mesh.position.lerp(rp.targetPos, 0.3); // Smooth movement
    }
    if (rp.targetRot !== undefined) {
      // Only rotate Y axis visually
      rp.mesh.rotation.y = THREE.MathUtils.lerp(rp.mesh.rotation.y, rp.targetRot, 0.3);
    }
  });
}

function updateBullets(dt) {
  for (let i = GameState.bullets.length - 1; i >= 0; i--) {
    const b = GameState.bullets[i];
    const moveDist = (b.speed || 50) * dt; // bullet speed

    b.mesh.position.addScaledVector(b.dir, moveDist);
    b.distTraveled += moveDist;

    // Check if it reached max hit distance
    if (b.maxDist !== null && b.distTraveled >= b.maxDist) {
      scene.remove(b.mesh);
      GameState.bullets.splice(i, 1);
      continue;
    }

    b.life -= dt;
    if (b.life <= 0) {
      scene.remove(b.mesh);
      GameState.bullets.splice(i, 1);
    }
  }
}

let lastPingTime = performance.now();

function gameLoop() {
  if (!GameState.isActive) return;

  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  // Animate Water Shaders
  waterMaterials.forEach(m => {
    if (m.uniforms && m.uniforms.uTime) {
      m.uniforms.uTime.value += dt;
    }
  });

  // Calculate ping locally over time
  if (now - lastPingTime > 1000) {
    if (GameState.isHost) {
      // Host sends ping to all clients
      broadcastToClients({ type: 'PING', time: now });
    } else {
      // Client sends ping to host
      sendToHost({ type: 'PING', time: now });
    }
    lastPingTime = now;
  }

  updateLocalPhysics(dt);
  updateRemotePlayers(dt);
  updateBullets(dt);

  UI.hud.fps.innerText = Math.round(1 / dt);

  renderer.render(scene, camera);
}


/**
 * WEAPONS & SHOOTING
 */
const raycaster = new THREE.Raycaster();

// Prevent shooting while reloading
let isReloading = false;
let lastFireTime = 0;

function shootWeapon() {
  if (isReloading) return;

  const wKey = GameState.localPlayer.weapon || 'rifle';
  const stats = WEAPONS[wKey];

  if (GameState.localPlayer.ammo <= 0) {
    // Auto-Reload mechanism
    isReloading = true;
    playSound('reload');

    // Simulate generic reload time
    setTimeout(() => {
      GameState.localPlayer.ammo = stats.mag;
      updateHUD();
      isReloading = false;
    }, 1500); // 1.5 seconds to reload

    return;
  }

  // Cooldown constraint
  if (Date.now() - lastFireTime < stats.fireRate) return;

  GameState.localPlayer.ammo--;
  updateHUD();
  lastFireTime = Date.now();

  const baseDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const origin = camera.position.clone();

  // Trigger Recoil Animation
  recoilTime = stats.recoil;
  flashTime = 0.08; // 80ms muzzle flash Duration

  playSound('shoot_' + wKey);

  // Collect targets (Players)
  const targets = [];
  Object.keys(GameState.remotePlayers).forEach(id => {
    const rp = GameState.remotePlayers[id];
    if (rp.mesh && rp.health > 0 && rp.mesh.visible) {
      targets.push(rp.mesh);
      rp.mesh.userData = { id: id, name: rp.name }; // Tag for easy lookup
    }
  });

  // Also collect environment to block walls (allow nested groups like houses)
  // CRITICAL FIX: To hit nested sub-meshes of grouped houses, we must pass the children and let raycaster traverse deep.
  const environment = [];
  scene.children.forEach(c => {
    if (c !== viewWeaponGroup && c.type !== 'PointLight' && c.type !== 'DirectionalLight' && c.type !== 'AmbientLight' && c.name !== 'Sky') {
      environment.push(c);
    }
  });

  const allObstacles = [...targets, ...environment];

  // Fire one or multiple pellets (shotgun)
  for (let p = 0; p < stats.pellets; p++) {
    // Apply Spread
    let currentSpread = stats.spread;

    // Immense inaccuracy penalty if hip-firing the sniper without aiming
    if (wKey === 'sniper' && !isAiming) {
      currentSpread = 0.08;
    }

    const dir = baseDir.clone();
    if (currentSpread > 0) {
      dir.x += (Math.random() - 0.5) * currentSpread;
      dir.y += (Math.random() - 0.5) * currentSpread;
      dir.z += (Math.random() - 0.5) * currentSpread;
      dir.normalize();
    }

    // Raycast to find limits (hit detection)
    raycaster.set(origin, dir);
    // CRITICAL: Second parameter is recursive (true). Mandatory so the raycaster checks 
    // inside the Groups we use for the multi-part house architectures instead of ignoring them.
    const intersects = raycaster.intersectObjects(allObstacles, true);

    let maxTravelDist = 1000; // Far away if no hit
    let hitPlayerId = null;
    let hitPlayerName = null;

    if (intersects.length > 0) {
      const hit = intersects[0];

      // CRITICAL FIX: The Three.js Raycaster returns scaled/transformed distances for objects 
      // inside deeply nested Groups (like the buildings). We MUST calculate the true 
      // mathematical world distance between the camera and the exact struck point.
      maxTravelDist = hit.point.distanceTo(origin); // Limit the bullet's visual flight to the wall/player hit

      // Determine if it was a player
      let obj = hit.object;

      while (obj && !hitPlayerId) {
        if (obj.userData && obj.userData.id) {
          hitPlayerId = obj.userData.id;
          hitPlayerName = obj.userData.name;
        }
        obj = obj.parent;
      }
    }

    // Network Blast (send maxDist so peers see it hit wall too)
    // Pass hit point and normal to create decal locally if it hit environment
    if (intersects.length > 0 && maxTravelDist !== 1000 && !hitPlayerId && hit.face) {
      const hitPoint = hit.point;
      const hitNormal = hit.face.normal.clone();
      // Transform normal if the object is rotated
      if (hit.object) {
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
        hitNormal.applyMatrix3(normalMatrix).normalize();
      }
      spawnHitDecal(hitPoint, hitNormal);

      const decalMsg = {
        type: 'DECAL',
        pos: [hitPoint.x, hitPoint.y, hitPoint.z],
        norm: [hitNormal.x, hitNormal.y, hitNormal.z]
      };
      if (GameState.isHost) broadcastToClients(decalMsg);
      else sendToHost(decalMsg);
    }

    // Local visuals (pass in MaxDist limit and weapon key for specific meshes)
    spawnNetworkBullet(origin, dir, GameState.localPlayer.color, maxTravelDist, stats.speed, wKey);

    const msg = {
      type: 'SHOOT',
      pos: [origin.x, origin.y, origin.z],
      dir: [dir.x, dir.y, dir.z],
      color: GameState.localPlayer.color,
      maxDist: maxTravelDist,
      speed: stats.speed,
      wKey: wKey
    };
    if (GameState.isHost) broadcastToClients(msg);
    else sendToHost(msg);

    // Handle Damage logic
    if (hitPlayerId) {
      showHitMarker();
      const hitMsg = {
        type: 'HIT',
        targetId: hitPlayerId,
        damage: stats.damage,
        shooterId: GameState.localPlayer.id,
        shooterName: GameState.localPlayer.name
      };
      if (GameState.isHost) {
        handlePlayerHit(hitMsg); // Process locally
        broadcastToClients(hitMsg);
      } else {
        sendToHost(hitMsg);
      }
    }
  }
}

function showHitMarker() {
  playSound('hit');
  UI.hud.crosshair.style.display = 'none';
  UI.hud.hitMarker.classList.add('show');
  UI.hud.hitMarker.style.opacity = '1';
  setTimeout(() => {
    UI.hud.hitMarker.style.opacity = '0';
    setTimeout(() => {
      UI.hud.hitMarker.classList.remove('show');
      if (isPointerLocked) UI.hud.crosshair.style.display = 'block';
    }, 100);
  }, 100);
}

UI.hud.hitMarker = document.getElementById('hit-marker'); // Need to register it

function spawnNetworkBullet(posArray, dirArray, colorHex, maxDist = null, speed = 50, wKey = 'rifle') {
  let ox = Array.isArray(posArray) ? posArray[0] : posArray.x;
  let oy = Array.isArray(posArray) ? posArray[1] : posArray.y;
  let oz = Array.isArray(posArray) ? posArray[2] : posArray.z;

  let dx = Array.isArray(dirArray) ? dirArray[0] : dirArray.x;
  let dy = Array.isArray(dirArray) ? dirArray[1] : dirArray.y;
  let dz = Array.isArray(dirArray) ? dirArray[2] : dirArray.z;

  const bGroup = new THREE.Group();

  // Brass color for casing, Copper for tip
  const matCasing = new THREE.MeshStandardMaterial({ color: 0xb5a642, metalness: 0.8, roughness: 0.2 });
  const matTip = new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.5, roughness: 0.4 });
  const matGreenTip = new THREE.MeshStandardMaterial({ color: 0x33aa33, metalness: 0.2, roughness: 0.6 });

  if (wKey === 'sniper') {
    // Large, long sniper round with a green armor-piercing tip
    const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.25, 8), matCasing);
    casing.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.04, 0.1, 8), matTip);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = -0.175;
    const gTip = new THREE.Mesh(new THREE.ConeGeometry(0.01, 0.03, 8), matGreenTip);
    gTip.rotation.x = Math.PI / 2;
    gTip.position.z = -0.24;

    bGroup.add(casing, tip, gTip);
  } else if (wKey === 'shotgun') {
    // Small spherical pellet (since shotgun shoots 8 of these)
    const pellet = new THREE.Mesh(new THREE.SphereGeometry(0.03, 4, 4), matCasing);
    bGroup.add(pellet);
  } else {
    // Standard Pistol / Rifle Round
    const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8), matCasing);
    casing.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 8), matTip);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = -0.075;
    bGroup.add(casing, tip);
  }

  // Add a very bright glowing tracer tail so bullets are highly visible!
  const tracerGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.0, 4);
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffffee, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.8 });
  const tracer = new THREE.Mesh(tracerGeo, tracerMat);
  tracer.rotation.x = Math.PI / 2;
  tracer.position.z = 0.5; // Offset trail behind the actual bullet head
  bGroup.add(tracer);

  bGroup.position.set(ox + dx * 0.5, oy + dy * 0.5, oz + dz * 0.5); // Start slightly ahead

  // Orient to face travel direction
  const targetPt = new THREE.Vector3(ox + dx, oy + dy, oz + dz);
  bGroup.lookAt(targetPt);

  scene.add(bGroup);

  GameState.bullets.push({
    mesh: bGroup,
    dir: new THREE.Vector3(dx, dy, dz),
    life: 2.0, // seconds
    maxDist: maxDist || null,
    distTraveled: 0,
    speed: speed
  });
}

const decals = [];
const maxDecals = 30;
const decalGeo = new THREE.CircleGeometry(0.12, 8); // Simple octagon "hole"
const decalMat = new THREE.MeshBasicMaterial({
  color: 0x111111,
  depthTest: true,
  depthWrite: false,
  transparent: true,
  opacity: 0.9,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4
});

function spawnHitDecal(posArray, normArray) {
  let px = Array.isArray(posArray) ? posArray[0] : posArray.x;
  let py = Array.isArray(posArray) ? posArray[1] : posArray.y;
  let pz = Array.isArray(posArray) ? posArray[2] : posArray.z;

  let nx = Array.isArray(normArray) ? normArray[0] : normArray.x;
  let ny = Array.isArray(normArray) ? normArray[1] : normArray.y;
  let nz = Array.isArray(normArray) ? normArray[2] : normArray.z;

  const hitPos = new THREE.Vector3(px, py, pz);
  const hitNormal = new THREE.Vector3(nx, ny, nz);

  const decal = new THREE.Mesh(decalGeo, decalMat);
  decal.position.copy(hitPos);

  // Look along normal to be flush with wall
  decal.lookAt(hitPos.clone().add(hitNormal));

  // Random rotation to make holes look distinct
  decal.rotation.z = Math.random() * Math.PI * 2;

  // Small variance in scale
  const scaleVariance = 0.8 + Math.random() * 0.5;
  decal.scale.set(scaleVariance, scaleVariance, 1);

  scene.add(decal);
  decals.push(decal);

  // Remove oldest decal if we exceed max decal count
  if (decals.length > maxDecals) {
    const oldDecal = decals.shift();
    scene.remove(oldDecal);
  }
}


function handlePlayerHit(msg) {
  // If the target is the local player, handle taking damage
  if (msg.targetId === GameState.localPlayer.id) {
    if (GameState.localPlayer.health > 0) {
      GameState.localPlayer.health -= msg.damage;
      updateHUD();
      playSound('hit');

      // Flash screen red simply
      document.body.style.boxShadow = "inset 0 0 100px red";
      setTimeout(() => document.body.style.boxShadow = "none", 150);

      if (GameState.localPlayer.health <= 0) {
        dieAndRespawn(msg.shooterId, msg.shooterName);

        // Broadcast Kill action
        const killMsg = {
          type: 'KILL',
          killer: { id: msg.shooterId, name: msg.shooterName },
          victim: { id: GameState.localPlayer.id, name: GameState.localPlayer.name }
        };

        // Handle locally
        handleKillFeed(killMsg.killer, killMsg.victim);

        if (GameState.isHost) {
          GameState.localPlayer.deaths++;
          if (msg.shooterId === GameState.localPlayer.id) GameState.localPlayer.kills++;
          else if (GameState.remotePlayers[msg.shooterId]) GameState.remotePlayers[msg.shooterId].kills++;

          broadcastToClients(killMsg);
          updateLeaderboard();
        } else {
          sendToHost(killMsg);
        }
      }
    }
  } else if (GameState.remotePlayers[msg.targetId]) {
    // Other player hit, apply visual damage or track health
    const rp = GameState.remotePlayers[msg.targetId];
    rp.health -= msg.damage;
    if (rp.health <= 0 && rp.mesh) {
      rp.mesh.visible = false;
      // Wait for KILL message to correctly allocate score
    }
  }
}

function handleKillFeed(killer, victim) {
  // Update local knowledge of score
  if (killer.id === GameState.localPlayer.id) GameState.localPlayer.kills++;
  else if (GameState.remotePlayers[killer.id]) GameState.remotePlayers[killer.id].kills++;

  if (victim.id === GameState.localPlayer.id) GameState.localPlayer.deaths++;
  else if (GameState.remotePlayers[victim.id]) GameState.remotePlayers[victim.id].deaths++;

  updateLeaderboard();

  // Add event to UI feed
  const log = document.createElement('div');
  log.className = 'kill-log';
  log.innerHTML = `<span class="killer">${killer.name}</span> <span class="icon">🔫</span> <span class="victim">${victim.name}</span>`;
  UI.hud.killfeed.appendChild(log);

  setTimeout(() => {
    log.remove();
  }, 4000);
}


/**
 * NETWORKING SYNC LOOP
 */
function networkTick() {
  if (!GameState.isActive || GameState.localPlayer.isDead) return;

  // Local player state payload
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  const payload = {
    id: GameState.localPlayer.id,
    pos: [camera.position.x, camera.position.y - 0.85, camera.position.z], // Adjust to body center
    rot: euler.y,
    health: GameState.localPlayer.health
  };

  if (GameState.isHost) {
    // Compile global state
    const worldState = { [payload.id]: payload };
    Object.keys(GameState.remotePlayers).forEach(id => {
      const rp = GameState.remotePlayers[id];
      if (rp.health > 0) {
        worldState[id] = { id: id, pos: [rp.position.x, rp.position.y, rp.position.z], rot: rp.rotation, health: rp.health };
      }
    });

    broadcastToClients({ type: 'STATE_SYNC', state: worldState });
  } else {
    // Send my state to host
    sendToHost({ type: 'STATE_SYNC', state: { [payload.id]: payload } });
  }
}

function applyStateSync(stateObj) {
  // calculate ping loosely
  const now = performance.now();
  if (GameState.isHost && Object.keys(stateObj).length > 0) {
    UI.hud.ping.innerText = 0; // Host ping is 0
  } else {
    UI.hud.ping.innerText = Math.round(now - lastPingTime);
  }
  lastPingTime = now;

  // Host: receive client dict, merge to remotePlayers
  // Client: receive all dict, merge to remotePlayers
  Object.keys(stateObj).forEach(id => {
    if (id === GameState.localPlayer.id) {
      // Occasionally validate my state or handle server correction
    } else if (GameState.remotePlayers[id]) {
      const rp = GameState.remotePlayers[id];
      const data = stateObj[id];
      // Set interpolation targets
      if (data.pos && data.pos.length === 3) {
        rp.targetPos = new THREE.Vector3(data.pos[0], data.pos[1], data.pos[2]);
        rp.position.set(data.pos[0], data.pos[1], data.pos[2]); // raw pos tracker
      }
      if (data.rot !== undefined) rp.targetRot = data.rot;
      if (data.health !== undefined) {
        if (rp.health <= 0 && data.health > 0) {
          // Respawned
          if (rp.mesh) rp.mesh.visible = true;
        }
        rp.health = data.health;
      }
    }
  });
}

/**
 * UI UPDATES
 */
function updateHUD() {
  UI.hud.health.innerText = GameState.localPlayer.health;
  UI.hud.healthBar.style.width = Math.max(0, GameState.localPlayer.health) + '%';
  if (GameState.localPlayer.health < 30) {
    UI.hud.healthBar.style.background = 'var(--danger)';
  } else {
    UI.hud.healthBar.style.background = 'var(--primary)';
  }

  // Update Ammo
  if (UI.hud.ammo) {
    UI.hud.ammo.innerText = GameState.localPlayer.ammo;
  }
}

function updateLeaderboard() {
  UI.hud.leaderboard.innerHTML = '';

  const allPlayers = [GameState.localPlayer, ...Object.values(GameState.remotePlayers)];
  // Sort by kills descending
  allPlayers.sort((a, b) => b.kills - a.kills);

  allPlayers.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name.substring(0, 8)}</span> <span class="highlight">${p.kills}</span>`;
    if (p.id === GameState.localPlayer.id) li.style.fontWeight = 'bold';
    UI.hud.leaderboard.appendChild(li);
  });
}

// Ensure first HUD is correct
setTimeout(updateHUD, 100);
setTimeout(updateLeaderboard, 100);

// Set up UI Event Listeners
UI.menu.btnHost.addEventListener('click', () => {
  GameState.localPlayer.name = UI.menu.username.value.trim() || 'Host';
  GameState.localPlayer.color = CONFIG.playerColors[Math.floor(Math.random() * CONFIG.playerColors.length)];
  GameState.isHost = true;
  GameState.roomCode = generateRoomCode();
  UI.menu.status.innerText = 'Creating room...';
  initPeerSession();
});

UI.menu.btnJoin.addEventListener('click', () => {
  const code = UI.menu.roomCode.value.trim().toUpperCase();
  if (code.length < 5) {
    UI.menu.status.innerText = 'Please enter a valid room code.';
    return;
  }
  GameState.localPlayer.name = UI.menu.username.value.trim() || 'Player';
  GameState.localPlayer.color = CONFIG.playerColors[Math.floor(Math.random() * CONFIG.playerColors.length)];
  GameState.isHost = false;
  GameState.roomCode = code;
  UI.menu.status.innerText = 'Initializing...';
  initPeerSession();
});

// Initial UI State
switchScreen('menu');

// Placeholder module export to make it valid module
export { };
