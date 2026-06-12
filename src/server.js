// src/server.js - Punto de entrada: levanta la web, las sesiones,
// Socket.IO (progreso y logs en tiempo real) y el programador de copias.
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const { Server } = require('socket.io');

const bus = require('./bus');
const logger = require('./logger');
const scheduler = require('./scheduler');
const { router } = require('./routes');
const { db } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
bus.setIO(io);

app.set('trust proxy', 1); // detrás de Nginx
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const sessionMiddleware = session({
  secret: process.env.APP_SECRET || 'cambia-esto',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: 86400000 }),
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax' },
});
app.use(sessionMiddleware);

// Socket.IO solo para sesiones iniciadas
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    if (socket.request.session && socket.request.session.admin) next();
    else next(new Error('No autorizado'));
  });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API para la extensión del panel (autenticación propia por clave)
const extapi = require('./extapi');
app.use('/api/ext', extapi.router);
extapi.ensureKey();

// Variables disponibles en todas las vistas
app.use((req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.ok = req.query.ok || null;
  res.locals.err = req.query.err || null;
  res.locals.can = (perm) => {
    const a = req.session.admin;
    return !!a && (a.is_root === 1 || (a.permissions || []).includes(perm));
  };
  // Tamaños legibles: B, KB, MB o GB según corresponda
  res.locals.fmtSize = (bytes) => {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
  };
  next();
});

app.use(router);

// 404
app.use((req, res) => res.status(404).redirect('/'));

const PORT = process.env.PORT || 3500;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  const admins = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  logger.info(`PteroBackups iniciado en http://${HOST}:${PORT}`);
  if (admins === 0) {
    console.log('\nAVISO: todavía no hay administradores. Crea el primero con:  npm run create-admin\n');
  }
  scheduler.start();
});
