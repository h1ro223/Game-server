/**
 * H1RO GAME SIGNAL SERVER
 * 3ゲーム共用 PeerJS シグナリングサーバー（Render 無料枠向け）
 *
 *   /race   … Turbo Pixel GP
 *   /action … Action Master
 *   /battle … Last Landing
 *   /health … 起動確認（wakeup.js が叩く）
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
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    peers,
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
  console.error('http error:', err && err.message ? err.message : err);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

/* ------------------------------------------------------------------ */
/* 起動 / 終了                                                         */
/* ------------------------------------------------------------------ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`signal server listening on :${PORT}`);
  console.log('routes:', GAMES.map((g) => g.path).join(' '), '/health');
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
