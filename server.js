/**
 * H1RO GAME SIGNAL SERVER
 * 3ゲーム共用 PeerJS シグナリングサーバー（Render 無料枠向け）
 *
 *   /race   … Turbo Pixel GP
 *   /action … Action Master
 *   /battle … Last Landing
 *   /health … 起動確認（wakeup.js が叩く）
 *   /<game>/rooms … 公開ルームの掲示板（GET=一覧 / POST=登録・更新・削除）
 *
 * made by hiro / ヒロ  https://github.com/h1ro223
 */
'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { ExpressPeerServer } = require('peer');

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 9000;

// 接続を許可するオリジン。基本は github.io のみ。
// ローカル確認したい時だけ Render の環境変数 EXTRA_ORIGINS に
// "http://127.0.0.1:5500,http://localhost:5500" のようにカンマ区切りで追加する。
const ALLOWED_ORIGINS = [
  'https://h1ro223.github.io',
  ...String(process.env.EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
];

const GAMES = [
  { path: '/race', title: 'Turbo Pixel GP' },
  { path: '/action', title: 'Action Master' },
  { path: '/battle', title: 'Last Landing' },
];

const PEER_KEY = 'peerjs'; // PeerJS クライアントの既定 key
const WS_MAX_PAYLOAD = 256 * 1024; // シグナリング(SDP/ICE)には十分。巨大データの送り付け対策

const isAllowedOrigin = (origin) => typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin);

// 公開ルーム掲示板の設定
const ROOM_TTL = 10 * 1000; // これ以上更新が途切れた部屋は消す
const ROOM_SWEEP = 3 * 1000; // 掃除の間隔
const ROOM_MAX_PER_GAME = 200; // 1ゲームあたりの掲載上限（荒らし対策）
const ROOM_BODY_LIMIT = '2kb';

/* ------------------------------------------------------------------ */
/* Express / HTTP                                                      */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render のプロキシ越し

const server = http.createServer(app);
// Render のロードバランサーより長くしておく（途中切断対策）
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

// 許可外オリジンには CORS ヘッダーを返さない → ブラウザ側でブロックされる
const corsOptions = {
  origin(origin, cb) {
    cb(null, isAllowedOrigin(origin));
  },
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  maxAge: 600,
};

/* ------------------------------------------------------------------ */
/* 公開ルーム掲示板（ゲームごとに独立。メモリ上だけに持つ）           */
/* ------------------------------------------------------------------ */
// ホストが約5秒おきに POST で部屋情報を送り、10秒途切れたら自動で消える。
// プライベートルームはゲーム側が送らないので載らない。
// ※ PeerJS のルートより先に登録すること（/race 以下を PeerJS が持っているため）
const boards = new Map(); // "/race" → Map(code → room)

const cleanStr = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, max);
const cleanInt = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const CODE_RE = /^[0-9]{4}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function sweepBoard(board, t = Date.now()) {
  for (const [code, room] of board) {
    if (t - room.updatedAt > ROOM_TTL) board.delete(code);
  }
}

function publicRoom(room, t) {
  return {
    code: room.code,
    name: room.name,
    players: room.players,
    max: room.max,
    course: room.course,
    cls: room.cls,
    status: room.status,
    age: Math.round((t - room.createdAt) / 1000),
  };
}

// fetch(text/plain) や sendBeacon でも受け取れるよう、text/plain の JSON も読む（プリフライト不要にするため）
const roomBody = express.json({ limit: ROOM_BODY_LIMIT, type: ['application/json', 'text/plain'] });

function requireAllowedOrigin(req, res, next) {
  // ブラウザ以外からの書き込みを減らすため、POST は Origin 必須
  if (!isAllowedOrigin(req.headers.origin)) return res.status(403).json({ error: 'forbidden' });
  next();
}

for (const game of GAMES) {
  const board = new Map();
  boards.set(game.path, board);
  const url = `${game.path}/rooms`;

  app.options(url, cors(corsOptions));

  // 一覧（入れる部屋→満員→レース中の順。同じ中では人数が多い順）
  const rank = (r) => (r.status === 'race' ? 2 : r.players >= r.max ? 1 : 0);
  app.get(url, cors(corsOptions), (req, res) => {
    const t = Date.now();
    sweepBoard(board, t);
    const rooms = [...board.values()]
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          b.players - a.players ||
          a.createdAt - b.createdAt
      )
      .slice(0, 50)
      .map((r) => publicRoom(r, t));
    res.set('Cache-Control', 'no-store');
    res.json({ rooms, time: t });
  });

  // 登録・更新（close:true で削除）
  app.post(url, cors(corsOptions), requireAllowedOrigin, roomBody, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : null;
    const code = b ? String(b.code || '') : '';
    const token = b ? String(b.token || '') : '';
    if (!CODE_RE.test(code) || !TOKEN_RE.test(token)) return res.status(400).json({ error: 'bad_request' });

    const t = Date.now();
    sweepBoard(board, t);
    const cur = board.get(code);
    // 同じ番号の部屋を別人が上書き・削除できないよう、最初に登録した token と照合
    if (cur && cur.token !== token) return res.status(409).json({ error: 'conflict' });

    if (b.close === true) {
      if (cur) board.delete(code);
      return res.json({ ok: true, closed: true });
    }
    if (!cur && board.size >= ROOM_MAX_PER_GAME) return res.status(503).json({ error: 'board_full' });

    const max = cleanInt(b.max, 1, 16, 8);
    board.set(code, {
      code,
      token,
      name: cleanStr(b.name, 12) || 'ホスト',
      players: cleanInt(b.players, 1, max, 1),
      max,
      course: cleanStr(b.course, 24),
      cls: cleanStr(b.cls, 16),
      status: b.status === 'race' ? 'race' : 'wait',
      createdAt: cur ? cur.createdAt : t,
      updatedAt: t,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ttl: ROOM_TTL });
  });
}

setInterval(() => {
  const t = Date.now();
  for (const board of boards.values()) sweepBoard(board, t);
}, ROOM_SWEEP).unref();

/* ------------------------------------------------------------------ */
/* PeerJS（ゲームごとに独立した部屋＝realm）                           */
/* ------------------------------------------------------------------ */
// ExpressPeerServer を複数立てると、各インスタンスの WebSocketServer が
// 同じ HTTP サーバーの upgrade を奪い合って 400 で切断してしまう。
// そこで noServer モードで作らせ、upgrade の振り分けを自前で行う。
const wsRoutes = new Map(); // "/race/peerjs" → { wss, game }

for (const game of GAMES) {
  const peerServer = ExpressPeerServer(server, {
    path: '/',
    key: PEER_KEY,
    proxied: true,
    allow_discovery: false, // 接続中ID一覧は公開しない
    alive_timeout: 60 * 1000,
    expire_timeout: 5 * 1000,
    concurrent_limit: 5000,
    corsOptions,
    createWebSocketServer(options) {
      const wss = new WebSocketServer({
        noServer: true,
        path: options.path, // 例: "/race/peerjs"
        maxPayload: WS_MAX_PAYLOAD,
      });
      wsRoutes.set(options.path, { wss, game });
      return wss;
    },
  });

  peerServer.on('error', (err) => {
    console.error(`[${game.path}] peer error:`, err && err.message ? err.message : err);
  });

  // ここで mount イベント → PeerServer 初期化 → createWebSocketServer が呼ばれる
  app.use(game.path, peerServer);
}

if (wsRoutes.size !== GAMES.length) {
  // peer のバージョン違いなどで振り分け表が作れなかった場合は起動を止める
  console.error('WebSocket ルートの初期化に失敗しました:', [...wsRoutes.keys()]);
  process.exit(1);
}

function rejectUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // 切断時の未処理エラーで落ちないように

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }

  const route = wsRoutes.get(pathname);
  if (!route) return rejectUpgrade(socket, 404, 'Not Found');

  // WebSocket は CORS の対象外なので Origin をここで直接チェック
  if (!isAllowedOrigin(req.headers.origin)) return rejectUpgrade(socket, 403, 'Forbidden');

  route.wss.handleUpgrade(req, socket, head, (ws) => {
    route.wss.emit('connection', ws, req);
  });
});

/* ------------------------------------------------------------------ */
/* 起動確認                                                            */
/* ------------------------------------------------------------------ */
app.get('/health', cors(corsOptions), (req, res) => {
  const peers = {};
  for (const { wss, game } of wsRoutes.values()) {
    peers[game.path.slice(1)] = wss.clients.size;
  }
  const rooms = {};
  const t = Date.now();
  for (const [path, board] of boards) {
    sweepBoard(board, t);
    rooms[path.slice(1)] = board.size;
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    peers,
    rooms,
    time: Date.now(),
  });
});

/* ------------------------------------------------------------------ */
/* トップ（直接開いた時用の簡易ページ）                                */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) => {
  const rows = GAMES.map((g) => `<li><code>${g.path}</code> ${g.title}</li>`).join('');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>H1RO GAME SIGNAL SERVER</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141833;color:#f2f4ff;
font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{padding:28px 24px;max-width:420px}h1{font-size:20px;margin:0 0 6px}
p{color:#9aa3c7;margin:0 0 16px;font-size:14px}ul{padding-left:18px;line-height:1.9}
code{color:#ffc94a}a{color:#ffc94a}footer{margin-top:24px;font-size:12px;color:#9aa3c7}
</style></head><body><main>
<h1>Game signal server is running</h1>
<p>ゲームの対戦接続を仲介するサーバーです。遊ぶときは各ゲームのページから接続してください。</p>
<ul>${rows}</ul>
<footer>made by hiro / ヒロ ・ <a href="https://github.com/h1ro223" target="_blank" rel="noopener">github.com/h1ro223</a></footer>
</main></body></html>`);
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 大きすぎる・壊れたJSONなどはクライアント側の問題として 4xx で返す
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (status >= 500) console.error('http error:', err && err.message ? err.message : err);
  if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'internal_error' : 'bad_request' });
});

/* ------------------------------------------------------------------ */
/* 起動 / 終了                                                         */
/* ------------------------------------------------------------------ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`signal server listening on :${PORT}`);
  console.log('routes:', GAMES.map((g) => g.path).join(' '), '/health', GAMES.map((g) => `${g.path}/rooms`).join(' '));
  console.log('allowed origins:', ALLOWED_ORIGINS.join(' '));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  for (const { wss } of wsRoutes.values()) {
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
