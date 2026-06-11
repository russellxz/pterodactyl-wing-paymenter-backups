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
  console.log('=== Crear administrador raíz (todos los permisos) ===\n');
  const first = await ask('Nombre: ');
  const last = await ask('Apellido: ');
  const email = (await ask('Correo electrónico: ')).toLowerCase();
  const password = await ask('Contraseña (mínimo 8 caracteres): ');
  rl.close();

  if (!first || !last) return fail('El nombre y el apellido son obligatorios.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('El correo electrónico no es válido.');
  if (password.length < 8) return fail('La contraseña debe tener al menos 8 caracteres.');

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
      console.log(`\nEl correo ya existía: se actualizó la contraseña y ahora es administrador raíz: ${email}`);
      process.exit(0);
    }
    return fail(e.message);
  }
  console.log(`\nAdministrador raíz creado correctamente: ${email}`);
  console.log('Ya puedes iniciar sesión en la página web del sistema.');
  process.exit(0);
})();

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}
