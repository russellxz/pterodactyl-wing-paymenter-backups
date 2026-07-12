// src/create-admin.js - Crea un ADMINISTRADOR RAÍZ desde la consola.
// Los administradores creados con este comando tienen TODOS los permisos
// y pueden eliminar o cambiar la contraseña de cualquier otro administrador.
// Puedes ejecutarlo cuantas veces quieras (por ejemplo, si pierdes el acceso).
//
// Uso:   npm run create-admin
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

(async () => {
  console.log('=== Create root administrator (all permissions) ===\n');
  const first = await ask('First name: ');
  const last = await ask('Last name: ');
  const email = (await ask('Email address: ')).toLowerCase();
  const password = await ask('Password (at least 8 characters): ');
  rl.close();

  if (!first || !last) return fail('First and last name are required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('That email address is not valid.');
  if (password.length < 8) return fail('The password must be at least 8 characters long.');

  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare(
      "INSERT INTO admins (first_name, last_name, email, password_hash, is_root, permissions) VALUES (?, ?, ?, ?, 1, '[]')"
    ).run(first, last, email, hash);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      // Si el correo ya existe, actualiza la contraseña y lo convierte en raíz (recuperación de acceso)
      db.prepare('UPDATE admins SET password_hash = ?, is_root = 1, first_name = ?, last_name = ? WHERE email = ?')
        .run(hash, first, last, email);
      console.log(`\nThat email already existed: the password was updated and it is now a root administrator: ${email}`);
      process.exit(0);
    }
    return fail(e.message);
  }
  console.log(`\nRoot administrator created successfully: ${email}`);
  console.log('You can now sign in on the system web page.');
  process.exit(0);
})();

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}
