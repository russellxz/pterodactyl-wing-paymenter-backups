// src/cipher.js - Cifra y descifra las contraseñas SSH/BD guardadas en la base de datos.
// La clave se deriva de APP_SECRET (.env). Si cambias APP_SECRET tendrás que
// volver a guardar las contraseñas de nodos y panel.
require('dotenv').config();
const crypto = require('crypto');

const KEY = crypto.createHash('sha256').update(process.env.APP_SECRET || 'cambia-esto').digest();

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  const [ivHex, encHex] = String(data).split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
