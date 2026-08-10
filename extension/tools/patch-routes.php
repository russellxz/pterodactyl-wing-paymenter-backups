<?php

/**
 * Añade (o quita) la pantalla "Backup 2.0" en el menú del área de cliente.
 *
 *   php patch-routes.php /var/www/pterodactyl
 *   php patch-routes.php /var/www/pterodactyl --remove
 *
 * Es el modo NATIVO: el botón se compila DENTRO del panel con yarn build,
 * igual que Consola, Archivos o Copias. No se añade ni una etiqueta a las
 * páginas del panel, así que el navegador (y Cloudflare) ven el panel tal cual.
 *
 * Toca un único archivo: resources/scripts/routers/routes.ts. Lo que añade va
 * entre marcas (// pterobackups:inicio ... // pterobackups:fin), y además deja
 * una copia del archivo original al lado, así que deshacerlo es exacto.
 *
 * Se puede ejecutar mil veces: si ya está puesto, no hace nada.
 *
 * Códigos de salida: 0 hecho · 1 error · 2 no había nada que hacer.
 */

$panel = rtrim($argv[1] ?? '/var/www/pterodactyl', '/');
$quitar = in_array('--remove', $argv, true);

const MARCA_INICIO = '// pterobackups:inicio';
const MARCA_FIN = '// pterobackups:fin';
const SUFIJO_COPIA = '.pterobackups-original';

function fallo(string $mensaje): void
{
    fwrite(STDERR, $mensaje . PHP_EOL);
    exit(1);
}

// --- 1. Localizar routes.ts -------------------------------------------------

$rutas = null;
foreach ([
    $panel . '/resources/scripts/routers/routes.ts',
    $panel . '/resources/scripts/routers/routes.tsx',
] as $candidato) {
    if (is_file($candidato)) {
        $rutas = $candidato;
        break;
    }
}

if ($rutas === null) {
    fallo('No se encontró resources/scripts/routers/routes.ts en ' . $panel . '.');
}

$original = file_get_contents($rutas);
if ($original === false) {
    fallo('No se pudo leer ' . $rutas);
}

// --- 2. Quitar --------------------------------------------------------------

if ($quitar) {
    $copia = $rutas . SUFIJO_COPIA;

    // Lo más fiable: si existe la copia del original, se restaura tal cual.
    if (is_file($copia)) {
        $contenidoCopia = file_get_contents($copia);
        if ($contenidoCopia !== false && file_put_contents($rutas, $contenidoCopia) !== false) {
            @unlink($copia);
            echo 'routes.ts restaurado desde la copia original.' . PHP_EOL;
            exit(0);
        }
    }

    if (!str_contains($original, MARCA_INICIO)) {
        echo 'No estaba puesto: no hay nada que quitar.' . PHP_EOL;
        exit(2);
    }

    $limpio = preg_replace(
        '/[ \t]*' . preg_quote(MARCA_INICIO, '/') . '.*?' . preg_quote(MARCA_FIN, '/') . '[ \t]*\R?/s',
        '',
        $original
    );

    if ($limpio === null || $limpio === $original) {
        fallo('No se pudo quitar el bloque de PteroBackups de routes.ts. Revísalo a mano.');
    }

    if (file_put_contents($rutas, $limpio) === false) {
        fallo('No se pudo escribir ' . $rutas . ' (¿permisos?).');
    }

    echo 'Quitado de routes.ts.' . PHP_EOL;
    exit(0);
}

// --- 3. Poner ---------------------------------------------------------------

if (str_contains($original, MARCA_INICIO)) {
    echo 'Ya estaba puesto en routes.ts: no se toca nada.' . PHP_EOL;
    exit(2);
}

// Por si una versión anterior lo dejó sin marcas.
if (str_contains($original, 'PteroBackupsContainer')) {
    fallo('routes.ts ya menciona PteroBackupsContainer pero sin las marcas de esta versión.' . PHP_EOL
        . 'Ejecuta primero el desinstalador y vuelve a instalar.');
}

$contenido = $original;

// 3.1 El import, detrás del ÚLTIMO import de la cabecera. Así no se cuela
//     entre las declaraciones lazy() que algunos temas ponen más abajo.
if (!preg_match_all('/^import .*$/m', $contenido, $coincidencias, PREG_OFFSET_CAPTURE)) {
    fallo('routes.ts no tiene ningún import: no parece el archivo correcto.');
}

$ultimoImport = end($coincidencias[0]);
$finImports = $ultimoImport[1] + strlen($ultimoImport[0]);

$bloqueImport = PHP_EOL
    . MARCA_INICIO . PHP_EOL
    . "import PteroBackupsContainer from '@/components/server/pterobackups/PteroBackupsContainer';" . PHP_EOL
    . MARCA_FIN;

$contenido = substr($contenido, 0, $finImports) . $bloqueImport . substr($contenido, $finImports);

// 3.2 La entrada del menú, al final del array server: [ ... ].
$posServer = strpos($contenido, 'server: [');
if ($posServer === false) {
    fallo('routes.ts no tiene el array "server: [". No parece el archivo correcto.');
}

$cierre = cierreDelArray($contenido, $posServer + strlen('server: [') - 1);
if ($cierre === null) {
    fallo('No se pudo encontrar el final del array "server" en routes.ts.');
}

// Se respeta la sangría que ya usa el archivo.
$sangria = sangriaDeLaLinea($contenido, $cierre) . '    ';

$bloqueRuta = $sangria . MARCA_INICIO . PHP_EOL
    . $sangria . '{' . PHP_EOL
    . $sangria . "    path: '/pterobackups'," . PHP_EOL
    . $sangria . "    permission: 'backup.*'," . PHP_EOL
    . $sangria . "    name: 'Backup 2.0'," . PHP_EOL
    . $sangria . '    component: PteroBackupsContainer,' . PHP_EOL
    . $sangria . '},' . PHP_EOL
    . $sangria . MARCA_FIN . PHP_EOL;

$inicioLinea = (int) strrpos(substr($contenido, 0, $cierre), PHP_EOL) + 1;
$contenido = substr($contenido, 0, $inicioLinea) . $bloqueRuta . substr($contenido, $inicioLinea);

// Copia del original ANTES de escribir, para poder deshacerlo exacto.
$copia = $rutas . SUFIJO_COPIA;
if (!file_exists($copia)) {
    @file_put_contents($copia, $original);
}

if (file_put_contents($rutas, $contenido) === false) {
    fallo('No se pudo escribir ' . $rutas . ' (¿permisos?).');
}

echo 'Añadido a routes.ts.' . PHP_EOL;
exit(0);

// ---------------------------------------------------------------------------

/**
 * Devuelve la posición del ] que cierra el [ que hay en $inicio, contando
 * corchetes y saltándose lo que haya dentro de comillas o de comentarios
 * (routes.ts tiene de todo: '/files/:action(edit|new)', comentarios, etc.).
 */
function cierreDelArray(string $texto, int $inicio): ?int
{
    $profundidad = 0;
    $largo = strlen($texto);

    for ($i = $inicio; $i < $largo; $i++) {
        $c = $texto[$i];
        $siguiente = $texto[$i + 1] ?? '';

        if ($c === '/' && $siguiente === '/') {
            $salto = strpos($texto, "\n", $i);
            $i = $salto === false ? $largo : $salto;
            continue;
        }

        if ($c === '/' && $siguiente === '*') {
            $fin = strpos($texto, '*/', $i);
            $i = $fin === false ? $largo : $fin + 1;
            continue;
        }

        if ($c === "'" || $c === '"' || $c === '`') {
            $i = finDeCadena($texto, $i);
            continue;
        }

        if ($c === '[') {
            $profundidad++;
        } elseif ($c === ']') {
            $profundidad--;
            if ($profundidad === 0) {
                return $i;
            }
        }
    }

    return null;
}

/** Posición de la comilla que cierra la cadena que empieza en $inicio. */
function finDeCadena(string $texto, int $inicio): int
{
    $comilla = $texto[$inicio];
    $largo = strlen($texto);

    for ($i = $inicio + 1; $i < $largo; $i++) {
        if ($texto[$i] === '\\') {
            $i++;
            continue;
        }
        if ($texto[$i] === $comilla) {
            return $i;
        }
    }

    return $largo;
}

/** Los espacios con los que empieza la línea donde está $posicion. */
function sangriaDeLaLinea(string $texto, int $posicion): string
{
    $inicioLinea = strrpos(substr($texto, 0, $posicion), PHP_EOL);
    $inicioLinea = $inicioLinea === false ? 0 : $inicioLinea + 1;

    preg_match('/^[ \t]*/', substr($texto, $inicioLinea, $posicion - $inicioLinea), $m);

    return $m[0] ?? '';
}
